import { resolveChecked } from "@fx/net-guard";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import { createInstallationHttp, createRepoInstallationResolver, InstallationTokenCache, loadAppCredentials, readAppBotLogin, type InstallationHttp, type InstallationHttpKind, type InstallationHttpTarget } from "@fx/github";
import { buildAccessTokenRequester, nodeHttpsPinnedRequester, type PinnedRequester } from "../../app/api/gh-proxy/[...path]/handler";

/**
 * D#483 P3: the production GitHub client the stage driver uses for its own calls (find the executor's pull request and its
 * changed files with a read token; run the merge gate with the `merge_gate` token). One cache per process, one client per
 * repository per call.
 *
 * Every call is logged as one line: method, path with the repository masked, status and, for an error status, GitHub's own
 * message cut short. Never a token, a header or a body.
 */
const cache = new InstallationTokenCache();
type Open = (kind: InstallationHttpKind, target: InstallationHttpTarget) => Promise<InstallationHttp>;
let open: Open | undefined;

function build(): Open {
  return createInstallationHttp({
    resolveInstallation: createRepoInstallationResolver(platformOpsPool()),
    appCredentials: loadAppCredentials(process.env),
    requester: buildAccessTokenRequester({ resolveUpstream: (host, lookupFn) => resolveChecked(host, lookupFn), forwardPinned: nodeHttpsPinnedRequester }),
    cache,
    log: (e) => console.info(JSON.stringify({ event: "advance.github_http", method: e.method, path: e.path, status: e.status, message: e.message })),
  });
}

export function openInstallationHttp(kind: InstallationHttpKind, target: InstallationHttpTarget): Promise<InstallationHttp> {
  open ??= build();
  return open(kind, target);
}

/**
 * D#6 R2b-3f: the login our App's pull requests carry on GitHub (`<slug>[bot]`) for the App that serves this repository. The App is the one
 * the repository's stored installation belongs to (the same resolution `openInstallationHttp` makes); GitHub is asked for its slug with the
 * App's own JWT. A repository with no usable installation, or an App that is not configured here, is an error.
 */
/**
 * A `fetch` for `GET https://api.github.com/app` that goes out the way the token mint does: the host is resolved and checked by the net guard,
 * and the socket is connected to that one validated address (the pinned requester, with its headers and idle timeouts), not to whatever
 * the global `fetch` resolves. Any other URL, any method but GET, and a redirect are refused. Used only by `readAppBotLogin`.
 */
export function createPinnedAppFetch(deps: { resolveUpstream?: (host: string) => Promise<string[]>; forwardPinned?: PinnedRequester } = {}): typeof fetch {
  const resolveUpstream = deps.resolveUpstream ?? ((host: string) => resolveChecked(host));
  const forwardPinned = deps.forwardPinned ?? nodeHttpsPinnedRequester;
  return (async (input: unknown, init?: RequestInit) => {
    if (input !== "https://api.github.com/app" || (init?.method ?? "GET") !== "GET") throw new Error("pinned app fetch: only GET https://api.github.com/app");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const addresses = await resolveUpstream("api.github.com");
    const address = addresses[0];
    if (address === undefined) throw new Error("pinned app fetch: no address");
    const res = await forwardPinned({ host: "api.github.com", address, method: "GET", path: "/app", headers, body: null });
    // A redirect is never followed: `readAppBotLogin` asked for `redirect: "error"`.
    if (res.status >= 300 && res.status < 400) throw new Error("pinned app fetch: redirect refused");
    const text = await new Response(res.bodyStream).text();
    return new Response(text, { status: res.status });
  }) as typeof fetch;
}

export async function readRepoAppLogin(repoId: string): Promise<string> {
  const installation = await createRepoInstallationResolver(platformOpsPool())(repoId);
  if (!installation) throw new Error("no installation");
  const credentials = loadAppCredentials(process.env)(installation.appKind);
  return readAppBotLogin({ appId: credentials.appId, privateKeyPem: credentials.privateKeyPem, fetchImpl: createPinnedAppFetch() });
}

/** Test seam: swap the opener; call with no argument to restore the production one. */
export function setInstallationHttpForTests(next?: Open): void {
  open = next;
}
