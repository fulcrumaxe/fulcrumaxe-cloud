import type { RepoPermission } from "@fx/trust";
import type { AppCredentialsSource } from "./appCredentials.js";
import { GH_OWNER_LOGIN_RE, GH_REPO_NAME_RE } from "./eventMapper.js";
import { toPermission } from "./issueAuthorLookup.js";
import { getInstallationToken, type AccessTokenRequester, type InstallationTokenCache } from "./installationToken.js";

/**
 * D#483 P1: the GitHub side of the stage driver's triage. The webhook stores no title, body or labels, so the driver
 * reads them here, with the same read-only, single-repo installation token the retry author check uses
 * (metadata:read and issues:read; no contents, no write).
 *
 * It reads: the issue (title, body, author, state, current labels), the issue's `labeled` events (who applied each
 * label), and the repository permission of each distinct actor behind a current label (at most MAX_ACTORS, so a crafted
 * issue cannot cost more than a bounded number of calls). It decides nothing about trust: it reports the actor and the
 * actor's real permission, and the pipeline's label rule judges them.
 *
 * Failure: anything that is not a definite answer THROWS a fixed-message error (5xx, 429, network, timeout, token mint).
 * A 404 or 410 on the issue is `missing`. A label whose actor cannot be established (no `labeled` event in the first
 * page of events, or a failed permission read for it) is reported with `actorLogin: null` / `actorPermission: null`, and
 * the pipeline ignores it: fail closed. Logins and label text never appear in a thrown message.
 */
export interface IssueReaderDeps {
  resolveInstallation: (repoId: string) => Promise<{ installationId: number; appKind: string } | null>;
  appCredentials: AppCredentialsSource;
  requester: AccessTokenRequester;
  cache: InstallationTokenCache;
  fetchImpl?: typeof fetch;
}

export interface IssueLabel {
  name: string;
  /** Who applied it (the newest `labeled` event for this name), or null when that cannot be established. */
  actorLogin: string | null;
  /** That actor's repository permission right now, or null when it was not read. */
  actorPermission: RepoPermission | null;
}

export type IssueReadResult =
  | { status: "missing" }
  | { status: "found"; title: string; body: string; login: string; state: string; labels: IssueLabel[] };

export interface IssueReadRequest {
  repoId: string;
  owner: string;
  name: string;
  number: number;
  signal?: AbortSignal;
}

export type IssueReader = (request: IssueReadRequest) => Promise<IssueReadResult>;

const CALL_TIMEOUT_MS = 10_000;
/** Labels and actors read per issue. Past these, the rest are reported without an actor (and so ignored). */
export const MAX_ISSUE_LABELS = 30;
export const MAX_LABEL_ACTORS = 5;
const MAX_EVENT_PAGES = 3;

export function createIssueReader(deps: IssueReaderDeps): IssueReader {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function get(url: string, token: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetchImpl(url, {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
        redirect: "error",
        signal: signal ? AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), signal]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      throw new Error("issueReader: request_failed");
    }
  }

  return async ({ repoId, owner, name, number, signal }) => {
    if (!GH_OWNER_LOGIN_RE.test(owner) || !GH_REPO_NAME_RE.test(name) || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error("issueReader: invalid_coordinates");
    }
    if (signal?.aborted) throw new Error("issueReader: aborted");
    const installation = await deps.resolveInstallation(repoId);
    if (!installation) throw new Error("issueReader: no_installation");
    const token = await getInstallationToken({
      installationId: installation.installationId,
      appKind: installation.appKind,
      purpose: "run",
      role: "author_check",
      scope: { repositories: [name], permissions: { metadata: "read", issues: "read" } },
      appCredentials: deps.appCredentials,
      requester: deps.requester,
      cache: deps.cache,
    });

    const repoPath = `https://api.github.com/repos/${owner}/${name}`;
    const res = await get(`${repoPath}/issues/${number}`, token, signal);
    if (res.status === 404 || res.status === 410) return { status: "missing" };
    if (res.status !== 200) throw new Error(`issueReader: issue_failed (${res.status})`);
    const j = (await res.json()) as { title?: unknown; body?: unknown; state?: unknown; user?: { login?: unknown } | null; labels?: unknown } | null;
    const login = j?.user?.login;
    if (typeof login !== "string" || login.length === 0) return { status: "missing" };
    const names: string[] = [];
    if (Array.isArray(j?.labels)) {
      for (const l of j.labels as unknown[]) {
        const n = typeof l === "string" ? l : (l as { name?: unknown } | null)?.name;
        if (typeof n === "string" && n.length > 0 && names.length < MAX_ISSUE_LABELS) names.push(n);
      }
    }

    // Who applied each current label: the newest `labeled` event with that name.
    const actorOf = new Map<string, string>();
    // Events are read oldest-first and capped. If the cap is hit with a full page, a later unlabel or relabel by a
    // less-trusted person may sit past it, so NO label's actor can be established (fail closed: no label counts).
    let capped = false;
    if (names.length > 0) {
      for (let page = 1; page <= MAX_EVENT_PAGES; page += 1) {
        const ev = await get(`${repoPath}/issues/${number}/events?per_page=100&page=${page}`, token, signal);
        if (ev.status !== 200) throw new Error(`issueReader: events_failed (${ev.status})`);
        const events = (await ev.json()) as Array<{ event?: unknown; label?: { name?: unknown } | null; actor?: { login?: unknown } | null }> | null;
        if (!Array.isArray(events)) break;
        for (const e of events) {
          if (e?.event === "labeled" && typeof e.label?.name === "string" && typeof e.actor?.login === "string") actorOf.set(e.label.name, e.actor.login);
          else if (e?.event === "unlabeled" && typeof e.label?.name === "string") actorOf.delete(e.label.name);
        }
        if (events.length < 100) break;
        if (page === MAX_EVENT_PAGES) capped = true;
      }
      if (capped) actorOf.clear();
    }

    // The permission of each distinct actor (bounded). An actor past the bound, or one whose read fails, stays unknown.
    const permissionOf = new Map<string, RepoPermission | null>();
    for (const actor of new Set(names.map((n) => actorOf.get(n)).filter((a): a is string => a !== undefined))) {
      if (permissionOf.size >= MAX_LABEL_ACTORS) break;
      const perm = await get(`${repoPath}/collaborators/${encodeURIComponent(actor)}/permission`, token, signal);
      if (perm.status === 404) permissionOf.set(actor, "none");
      else if (perm.status === 200) permissionOf.set(actor, toPermission((await perm.json()) as { role_name?: unknown; permission?: unknown } | null));
      else throw new Error(`issueReader: permission_failed (${perm.status})`);
    }

    return {
      status: "found",
      title: typeof j?.title === "string" ? j.title : "",
      body: typeof j?.body === "string" ? j.body : "",
      login,
      state: typeof j?.state === "string" ? j.state : "unknown",
      labels: names.map((n) => {
        const actor = actorOf.get(n) ?? null;
        return { name: n, actorLogin: actor, actorPermission: actor !== null && permissionOf.has(actor) ? (permissionOf.get(actor) ?? null) : null };
      }),
    };
  };
}
