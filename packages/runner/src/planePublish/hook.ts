import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PLANE_REFUSAL_CODES,
  PlaneRouteError,
  assertSafeLocalConfig,
  createGitTransport,
  planePushGit,
  routeAndPush,
  type PlaneRefusalCode,
  type PublicApi,
  type PublicGitTransport,
  type Refusal,
} from "@fulcrumaxe/runner-protocol/planePush";
import { phaseLine, type PlanePublishInput, type PlanePublishLine } from "./protocol.js";

/**
 * D#598 P1f-5a: the publish hook that runs inside a `pp-` sandbox, built to `fx-plane-publish.mjs` and written there by the worker.
 *
 * Threat model. In: a hostile private branch (the agent's output: crafted files, paths, objects, a config or hook planted to run during a
 * transfer), and text the agent wrote trying to reach the public repository. Not in: a compromised GitHub, proxy or provider.
 *  - The sandbox holds no credential and no model connection (env = the CA paths only), and its network is GitHub's two hosts forwarded to the
 *    gh-proxy, which decides every request (read of the two repositories; create of the one recorded branch; that branch's ref; the PR) and
 *    attaches its own per-request token outside this VM. This file never sees, builds, logs or writes a token. The one value sent where a token
 *    would go (`BROKERED`) is a fixed marker the proxy discards.
 *  - No shell: every child is `git` with an argv through `planePushGit` (scrubbed `GIT_*`, config, hooks and replace objects pinned off).
 *  - The repository is made here with `git init --bare` in a fresh 0700 directory, so no `remote.*`, `branch.*` or `user.*` key exists
 *    (`assertSafeLocalConfig` checks it before each transfer), and it is removed on every outcome.
 *  - The branch, the PR text and the identity come from the worker's input, never from the repository. Output is `phaseLine`s only: codes and
 *    place-plus-rule-key entries, never a matched value, file content or error text.
 * Accepted residual: the pairing is read by the worker before it starts this hook, so a pairing edited during the run is not seen here; the
 * worker re-reads it afterwards and the hosted side verifies the branch against GitHub before recording.
 */

/** The marker where a token would be: the proxy replaces the whole credential, so the value is not secret and means nothing to GitHub. */
export const BROKERED = "brokered-at-proxy";

/** The system bundle the role env exports (`SANDBOX_CA_ENV`); a test keeps the two equal. Pinned so git never depends on its compiled-in default. */
export const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const HARDENING = (origin: string): string[] => [
  "-c", "protocol.allow=never", "-c", `protocol.${new URL(origin).protocol === "https:" ? "https" : "http"}.allow=always`,
  "-c", "http.proxy=", "-c", "http.sslVerify=true", "-c", "http.followRedirects=false", "-c", "credential.helper=", "-c", "core.askPass=",
  "-c", "transfer.fsckObjects=true", "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
  "-c", `http.sslCAInfo=${SYSTEM_CA_BUNDLE}`,
];
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", GIT_CONFIG_NOSYSTEM: "1" } as const;
const CALL_TIMEOUT_MS = 15_000;
const MAX_REPLY_BYTES = 256 * 1024;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,330}$/;

class ApiError extends Error {
  constructor(readonly code: "public_unavailable" | "pr_failed" | "token_scope_mismatch") {
    super(code);
  }
}

/** The two calls the route makes to the public API, with no `Authorization` header: the proxy decides them and adds the credential. */
export function createProxyPublicApi(codeRepo: string, apiOrigin: string, fetchFn: typeof fetch = fetch): PublicApi {
  const call = async (method: "GET" | "POST", pathname: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    try {
      const res = await fetchFn(new URL(pathname, apiOrigin), {
        method,
        headers: { accept: "application/vnd.github+json", "user-agent": "fulcrumaxe-publish", "x-github-api-version": "2022-11-28", ...(body !== undefined && { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const raw = (await res.text()).slice(0, MAX_REPLY_BYTES);
      let json: unknown = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        // fx-swallow-ok: a body that is not JSON reads as the wrong shape, which every caller refuses
      }
      return { status: res.status, json: typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {} };
    } catch {
      // fx-swallow-ok: replaced by a closed code; the original text can carry the request address
      throw new ApiError("public_unavailable");
    }
  };
  const [owner, name] = codeRepo.split("/") as [string, string];
  return {
    async mintPushToken(repo) {
      if (repo.toLowerCase() !== codeRepo.toLowerCase()) throw new ApiError("token_scope_mismatch");
      return BROKERED;
    },
    async branchExists({ codeRepo: repo, branch }) {
      if (repo !== codeRepo || !BRANCH.test(branch) || branch.includes("..")) throw new ApiError("public_unavailable");
      const res = await call("GET", `/repos/${owner}/${name}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      throw new ApiError("public_unavailable");
    },
    async branchHead({ codeRepo: repo, branch }) {
      if (repo !== codeRepo || !BRANCH.test(branch) || branch.includes("..")) throw new ApiError("public_unavailable");
      const res = await call("GET", `/repos/${owner}/${name}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
      if (res.status === 404) return null;
      const object = res.json.object;
      const sha = typeof object === "object" && object !== null ? (object as { sha?: unknown }).sha : undefined;
      if (res.status !== 200 || typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw new ApiError("public_unavailable");
      return sha;
    },
    async openPullRequest({ codeRepo: repo, branch, base, title, body }) {
      if (repo !== codeRepo) throw new ApiError("public_unavailable");
      const res = await call("POST", `/repos/${owner}/${name}/pulls`, { title, head: branch, base, body, maintainer_can_modify: false });
      const { number, html_url: url } = res.json;
      const pull = new RegExp(`^https://github\\.com/${owner}/${name.replace(/[.]/g, "\\.")}/pull/(\\d+)$`, "i");
      if (res.status !== 201 || typeof number !== "number" || !Number.isSafeInteger(number) || typeof url !== "string" || pull.exec(url)?.[1] !== String(number)) {
        throw new ApiError(res.status >= 500 || res.status === 429 ? "public_unavailable" : "pr_failed");
      }
      return { number, url };
    },
  };
}

const codeOf = (error: unknown): PlaneRefusalCode | undefined => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && (PLANE_REFUSAL_CODES as readonly string[]).includes(code) ? (code as PlaneRefusalCode) : undefined;
};

const shown = (s: string): string => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 300) || "-";
/** The route's refusals as the output carries them: a kind, a place (path and line) and a rule key. Matched text is never in a `Refusal`. */
function closed(refusals: readonly Refusal[]): NonNullable<PlanePublishLine["refusals"]> {
  return refusals.slice(0, 100).map((r) => ({ kind: shown(r.kind), place: shown(r.path === undefined ? "-" : `${r.path}${r.line === undefined ? "" : `:${r.line}`}`), rule_key: shown(r.rule ?? r.kind) }));
}

export interface PlanePublishDeps {
  /** `https://github.com` and `https://api.github.com` in the sandbox; a loopback http origin in a test. */
  gitOrigin: string;
  apiOrigin: string;
  say: (line: string) => void;
  fetchFn?: typeof fetch;
  tmpRoot?: string;
}

export async function runPlanePublish(input: PlanePublishInput, deps: PlanePublishDeps): Promise<void> {
  const say = (l: PlanePublishLine): void => deps.say(phaseLine(l));
  say({ phase: "building" });
  const inner = createGitTransport({ origin: deps.gitOrigin, caInfo: SYSTEM_CA_BUNDLE });
  let tip: string | undefined;
  let commit: string | undefined;
  let scanning = false;
  const transport: PublicGitTransport = {
    async fetchTip(dir, repo) {
      tip = await inner.fetchTip(dir, repo);
      if (!scanning) {
        scanning = true;
        say({ phase: "scanning" });
      }
      return tip;
    },
    async push(i) {
      await inner.push(i);
      commit = i.commit;
      // An update reports once, at the end, as `updated`; `pushed` is the first push of a branch.
      if (tip !== undefined && i.expectedHead === undefined) say({ phase: "pushed", branch: i.branch, head_sha: i.commit, tip_sha: tip });
    },
  };
  const pairing = { enabled: true as const, codeRepo: input.codeRepo, overlayGlobs: input.pairing.overlayGlobs, identifierRulesPath: input.pairing.identifierRulesPath, planDataRulesPath: input.pairing.planDataRulesPath };
  let work: string | undefined;
  let final: PlanePublishLine;
  try {
    work = mkdtempSync(path.join(deps.tmpRoot ?? tmpdir(), "fx-pp-"));
    await planePushGit(work, ["init", "--bare", "--quiet", "--template="]);
    await assertSafeLocalConfig(work);
    try {
      await planePushGit(
        work,
        [...HARDENING(deps.gitOrigin), "fetch", "--no-tags", "--quiet", "--no-write-fetch-head", `${deps.gitOrigin}/${input.own.owner}/${input.own.name}.git`, `${input.privateHead}:refs/fx/head`, `${input.privateBase}:refs/fx/base`, `${input.privateDefaultTip}:refs/fx/default`],
        undefined,
        NO_PROMPT,
      );
      await planePushGit(work, ["merge-base", "--is-ancestor", input.privateBase, input.privateHead]);
    } catch {
      // fx-swallow-ok: replaced by the closed refusal; the tool's text can carry an address
      throw new PlaneRouteError("bad_input", "the run's commits could not be read from the private repository");
    }
    const result = await routeAndPush(
      { repoDir: work, privateBase: input.privateBase, privateHead: input.privateHead, privateDefaultTip: input.privateDefaultTip, own: input.own, defaultBranch: "main", branch: input.branch, ...(input.updateOf === undefined ? {} : { updateOf: input.updateOf }), title: input.title, body: input.body, identity: input.identity, commitTime: input.commitTime },
      { loadPairing: async () => pairing, loadOwn: async () => input.own, api: createProxyPublicApi(input.codeRepo, deps.apiOrigin, deps.fetchFn), transport },
    );
    final =
      result.plane === "paired"
        ? { phase: "pr_opened", branch: result.branch, head_sha: result.commit, tip_sha: result.tip, pr_number: result.number }
        : result.plane === "updated"
          ? { phase: "updated", branch: result.branch, head_sha: result.commit, tip_sha: result.tip }
          : { phase: "refused", code: "bad_input" };
  } catch (error) {
    // fx-swallow-ok: the failure becomes the terminal line's closed code and place; its text is never sent
    if (error instanceof PlaneRouteError && error.code === "no_changes") final = { phase: "no_change" };
    else if (error instanceof PlaneRouteError && error.code === "pr_failed" && error.pushed && commit !== undefined && tip !== undefined) final = { phase: "pr_failed", branch: input.branch, head_sha: commit, tip_sha: tip };
    else {
      // A closed code (a route refusal, or the config check's own) is a refusal. Anything else (a failed mkdtemp, an unexpected git failure) is
      // not a decision about the change: it is rethrown after the cleanup below, so the run ends with no terminal line and reads as a crash.
      const code = codeOf(error);
      if (code === undefined) throw error;
      const refusals = error instanceof PlaneRouteError ? closed(error.refusals) : [];
      final = { phase: "refused", code, ...(refusals.length > 0 && { refusals }) };
    }
  } finally {
    // A detached `git gc --auto` can still be writing as the transfer ends; the retries cover it.
    if (work !== undefined) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  // After the removal: a run killed before this line leaves no terminal line, which the worker reads as a crash.
  say(final);
}
