import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INSTALL_PLATFORMS, TUF_BUILD, TufClient, newestRelease, renderInstallScript, type TufBuildConfig } from "./index.js";

/**
 * GET /install.sh (D#845 ON-4a). The runner's own TUF client verifies the release metadata here, on the server, and the answer is
 * the stock install.sh with the verified version, SHA-256 and length of each platform's file written into it. The machine that runs the script
 * needs only sh, curl and sha256sum or shasum.
 *
 * What this does and does not protect. A person who runs `curl https://<origin>/install.sh | sh` trusts the origin: whoever controls it over
 * HTTPS controls every byte the script runs, whatever the script says about itself. What TUF adds is everything behind the origin: a replaced
 * release file, tampered metadata on the release host, a rollback to an older signed release, a freeze past the timestamp's expiry. The
 * trust is the root compiled into the runner build (`TUF_BUILD`), the same one the installed runner uses for its own updates. A cold
 * function instance starts from that root, like any fresh TUF client.
 *
 * Nothing the caller sends changes anything: there is no argument, header, cookie or query parameter that moves the trust or the URLs.
 * Only tests pass `{ build, ca, stateDir }` to the factory; the route file passes nothing. The body is the same for every visitor at a given
 * moment and holds no account data and no token.
 *
 * Fail closed, and loudly through a pipe. When the release cannot be verified the answer is still 200, with a script that prints one
 * fixed line to stderr and exits 1, and the reason in `x-fx-install-state`: a non-2xx answer under `curl -f ... | sh` hands sh an empty
 * input, which exits 0 and tells the person nothing. Until the first release is published the production build has no metadata address, so it
 * serves exactly that refusal (`not_configured`).
 */

export interface InstallScriptRouteOptions {
  /** What is trusted and where it is fetched from. Only tests pass anything but the compiled-in default. */
  build?: TufBuildConfig;
  /** Extra TLS trust anchor for a local test server. Production never sets it. */
  ca?: string | Buffer;
  /** Where the TUF client keeps its metadata. Default: a private directory under the temp directory, made on first use. */
  stateDir?: string;
}

/** A verified selection is kept at most this long, and never past the earliest `expires` of the metadata it came from. */
export const SELECTION_TTL_MS = 60_000;
/** A refusal is kept this long, so a flood of anonymous requests costs one verification, not one each. */
export const REFUSAL_TTL_MS = 5_000;
/** How long one request waits for a verification before it answers `refused:timeout`. Well inside a serverless function's own limit. */
export const VERIFY_DEADLINE_MS = 20_000;

const HEADERS = { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } as const;

/** One fixed line per state. It never carries server text, an address, or a code that a person's shell could be handed from outside. */
const REFUSAL_LINES: Record<string, string> = {
  not_configured: "fx-runner install: not_configured: no runner release is published yet. Nothing was installed.",
  paused: "fx-runner install: paused: the release metadata has expired and installs are paused. Nothing was installed.",
  refused: "fx-runner install: refused: the runner release could not be verified. Nothing was installed.",
};

interface Verdict {
  body: string;
  /** `ok`, or the refusal state, with `:<code>` when there is one. */
  state: string;
  until: number;
}

const refusalScript = (state: string): string => `#!/bin/sh\nprintf '%s\\n' '${REFUSAL_LINES[state] ?? REFUSAL_LINES["refused"]}' >&2\nexit 1\n`;

export function createInstallScriptRoute(options: InstallScriptRouteOptions = {}): () => Promise<Response> {
  const build = options.build ?? TUF_BUILD;
  let stateDir = options.stateDir;
  let kept: Verdict | undefined;
  let inflight: Promise<Verdict> | undefined;

  const refuse = (state: "not_configured" | "paused" | "refused", code: string | undefined, now: number): Verdict => ({
    body: refusalScript(state),
    state: code === undefined ? state : `${state}:${code}`,
    until: now + REFUSAL_TTL_MS,
  });

  async function verify(now: number): Promise<Verdict> {
    const { root, metadataBaseUrl, targetBaseUrl } = build;
    if (root === undefined || metadataBaseUrl === undefined || targetBaseUrl === undefined) return refuse("not_configured", undefined, now);
    try {
      stateDir ??= mkdtempSync(path.join(tmpdir(), "fx-install-tuf-"));
      const client = new TufClient({ stateDir, build, ca: options.ca });
      const listed = await client.listTargets();
      if (!listed.ok) return refuse(listed.state, listed.state === "not_configured" ? undefined : listed.code, now);
      const version = newestRelease(listed.paths, INSTALL_PLATFORMS);
      if (version === undefined) return refuse("refused", "no_complete_release", now);
      const entries: Array<{ platform: string; sha256: string; size: number }> = [];
      let expiresAt = Number.POSITIVE_INFINITY;
      for (const platform of INSTALL_PLATFORMS) {
        const info = await client.targetInfo(`v${version}/fx-runner-${platform}`);
        if (!info.ok) return refuse(info.state, info.state === "not_configured" ? undefined : info.code, now);
        entries.push({ platform, sha256: info.sha256, size: info.length });
        expiresAt = info.expiresAt === undefined ? Number.NEGATIVE_INFINITY : Math.min(expiresAt, info.expiresAt);
      }
      const body = renderInstallScript({ version, entries, targetBaseUrl, trustedRootSha256: createHash("sha256").update(root, "utf8").digest("hex") });
      // An expiry that could not be read means the selection is not kept at all: serve it once, verify again next time.
      return { body, state: "ok", until: Math.min(now + SELECTION_TTL_MS, expiresAt) };
    } catch {
      // fx-swallow-ok: fail closed; the refusal below carries a fixed code and is logged, and the error text is never shown
      return refuse("refused", "internal", now);
    }
  }

  return async function GET(): Promise<Response> {
    const now = Date.now();
    let current = kept;
    // The upper bound also drops a selection kept before the clock went back.
    if (current === undefined || current.until <= now || current.until > now + SELECTION_TTL_MS) {
      // One verification at a time: the TUF client writes its metadata into one directory, and a flood of requests costs one run.
      inflight ??= verify(now)
        .then((verdict) => {
          if (verdict.state !== "ok") console.warn("install_script_refused", { state: verdict.state });
          return verdict;
        })
        .finally(() => {
          inflight = undefined;
        });
      // A hung metadata host must not hold the answer past the function's own timeout: a platform timeout under `curl -f ... | sh` is a
      // silent exit 0. The slow verification keeps running (and stays the single one in flight); this request answers with a refusal.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<Verdict>((resolve) => {
        timer = setTimeout(() => {
          console.warn("install_script_refused", { state: "refused:timeout" });
          resolve(refuse("refused", "timeout", Date.now()));
        }, VERIFY_DEADLINE_MS);
      });
      try {
        current = await Promise.race([inflight, late]);
      } finally {
        clearTimeout(timer);
      }
      kept = current;
    }
    return new Response(current.body, { status: 200, headers: { ...HEADERS, "x-fx-install-state": current.state } });
  };
}
