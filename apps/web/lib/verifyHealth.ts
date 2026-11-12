import { resolveChecked } from "@fx/net-guard";
import { reportError } from "@fx/telemetry";
import type { HealthRead } from "@fx/worker";
import { nodeHttpsPinnedRequester, type PinnedRequester } from "../app/api/gh-proxy/[...path]/handler";

/**
 * D#749 V3a: the reader of a deployed app's /api/health for the post-merge verify stage (CWE-918). The base URL comes from a repository's settings, so it is not trusted:
 * the host is resolved and checked by the net guard (`resolveChecked`: no private, loopback or link-local address), and the socket is connected to that one validated
 * address with SNI and Host kept as the app's host, over verified TLS. It is not the global `fetch`. It sends one request, `GET /api/health`, with a User-Agent (the
 * platform refuses a request without one), follows no redirect, reads at most MAX_BODY_BYTES and gives up after TIMEOUT_MS in all. A base URL with a path, query,
 * credentials, a port (the settings check, parseBaseUrl, refuses one too, so a saved address is always readable) or a scheme other than https is refused before anything is resolved. Anything that is not a plain JSON answer from the app
 * (a 3xx, a 5xx other than the health route's own 503, a body too large or not JSON, a refused address, a timeout) reads as `unreachable`; the stage never acts on page text.
 * The answer carries the commit only when it is a commit id.
 *
 * Deployment Protection: the staging app answers a bare request with a 302 to Vercel's sign-in, which reads as unreachable. When the platform-provided
 * VERCEL_AUTOMATION_BYPASS_SECRET is set, the request to THIS project's own host (and only that) carries `x-vercel-protection-bypass`. "Own host" is decided from the
 * platform's own variables, never from the untrusted base URL: the base URL's hostname must equal, exactly (case-folded, no wildcard, no suffix match), one of the hosts in
 * VERCEL_URL, VERCEL_BRANCH_URL, VERCEL_PROJECT_PRODUCTION_URL, or the optional comma list FX_VERIFY_OWN_HOSTS (for a custom domain of this project that the
 * platform variables do not name). Both inputs are read once, when the reader is built. A foreign host gets no header, a redirect is never followed (so the secret cannot
 * ride one), and the secret is scrubbed from any error text before it is reported.
 *
 * Whose row it is (CWE-441, confused deputy): the base URL is a tenant's own setting, so a tenant could name OUR staging hostname and have this server attach OUR bypass
 * secret to a request on their behalf, learning whether staging is up and which commit it runs. The header is therefore sent only for a row of the platform's own
 * account(s): the ones FX_OPERATOR_ACCOUNT_IDS lists (the same list that says which accounts are ours elsewhere). A row of any other account, an unreadable list (one
 * malformed entry turns the whole list off, as there) or a call that names no account gets no header, and its read of our host answers unreachable like any protected app.
 */
export const MAX_BODY_BYTES = 16_384;
export const TIMEOUT_MS = 10_000;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const unreachable: HealthRead = { kind: "unreachable" };
export const BYPASS_HEADER = "x-vercel-protection-bypass";
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

/** The secret, only when it is one value of printable characters (as the runner's own reader requires); anything else reads as unset. */
function readBypassSecret(env: Record<string, string | undefined>): string | undefined {
  const v = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return v !== undefined && v.length > 0 && v.length <= 256 && /^[\x21-\x7e]+$/.test(v) ? v : undefined;
}

/** This project's own hostnames, from the platform's variables (bare hosts, no scheme) and the optional list. A value that is not a bare hostname is dropped. */
function ownHosts(env: Record<string, string | undefined>): Set<string> {
  const out = new Set<string>();
  const raw = [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL, ...(env.FX_VERIFY_OWN_HOSTS ?? "").split(",")];
  for (const r of raw) {
    const h = (r ?? "").trim().toLowerCase();
    if (HOSTNAME.test(h) && h.includes(".") && !/^[0-9.]+$/.test(h)) out.add(h);
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The platform's own account ids (lower case): a comma list of UUIDs, empty when unset or when any entry is not a UUID (the whole list is then off). */
function platformAccounts(env: Record<string, string | undefined>): ReadonlySet<string> {
  const raw = env.FX_OPERATOR_ACCOUNT_IDS;
  if (raw === undefined || raw.trim() === "") return new Set();
  const ids = raw.split(",").map((part) => part.trim());
  return ids.some((id) => !UUID.test(id)) ? new Set() : new Set(ids.map((id) => id.toLowerCase()));
}

function scrub(err: unknown, secret: string | undefined): unknown {
  if (secret === undefined) return err;
  const clean = (t: string) => t.split(secret).join("[redacted]");
  const e = new Error(clean(err instanceof Error ? err.message : String(err)));
  e.name = err instanceof Error ? err.name : "Error";
  if (err instanceof Error && err.stack !== undefined) e.stack = clean(err.stack);
  return e;
}

async function readCapped(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createVerifyHealthReader(deps: { resolveUpstream?: (host: string) => Promise<string[]>; forwardPinned?: PinnedRequester; timeoutMs?: number; env?: Record<string, string | undefined> } = {}): (baseUrl: string, who?: { accountId: string }) => Promise<HealthRead> {
  const resolveUpstream = deps.resolveUpstream ?? ((host: string) => resolveChecked(host));
  const forwardPinned = deps.forwardPinned ?? nodeHttpsPinnedRequester;
  const env = deps.env ?? process.env;
  const secret = readBypassSecret(env);
  const own = secret === undefined ? new Set<string>() : ownHosts(env);
  const ours = secret === undefined ? new Set<string>() : platformAccounts(env);
  return async (baseUrl, who) => {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      // fx-swallow-ok: an address that does not parse reads as unreachable, the fixed answer
      return unreachable;
    }
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return unreachable;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (async (): Promise<HealthRead> => {
      try {
        const address = (await resolveUpstream(url.hostname))[0];
        if (address === undefined) return unreachable;
        const res = await forwardPinned({ host: url.hostname, address, method: "GET", path: "/api/health", headers: { "user-agent": "fulcrumaxe-cloud", accept: "application/json", ...(secret !== undefined && who !== undefined && ours.has(who.accountId.toLowerCase()) && own.has(url.hostname.toLowerCase()) ? { [BYPASS_HEADER]: secret } : {}) }, body: null });
        // The health route answers 200 (settings complete) or 503 (incomplete); both carry the identity. A redirect is never followed.
        if (res.status !== 200 && res.status !== 503) {
          await res.bodyStream?.cancel().catch(() => undefined);
          return unreachable;
        }
        const text = await readCapped(res.bodyStream);
        if (text === null) return unreachable;
        const body: unknown = JSON.parse(text);
        if (body === null || typeof body !== "object" || Array.isArray(body)) return unreachable;
        const commit = (body as { commit?: unknown }).commit;
        return { kind: "ok", commit: typeof commit === "string" && COMMIT_ID.test(commit) ? commit : null };
      } catch (err) {
        reportError(scrub(err, secret), { stage: "verify_stage.health" });
        return unreachable;
      }
    })();
    const timeout = new Promise<HealthRead>((resolve) => {
      timer = setTimeout(() => resolve(unreachable), deps.timeoutMs ?? TIMEOUT_MS);
    });
    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}
