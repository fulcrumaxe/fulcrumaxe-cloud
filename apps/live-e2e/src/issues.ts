/**
 * Issue upsert for scheduled and post-deploy runs (T2b): one issue per failing pack and target, titled by
 * `issueTitle` and labelled `live-e2e`.
 *
 *   - a pack that failed with no open issue opens one;
 *   - a pack that failed again comments on the open issue and opens nothing new;
 *   - a pack that passed closes its open issue (a skip, a flaky pass or a refusal leaves it as it is);
 *   - a production failure also carries `needs-owner`.
 *
 * Issue text is built from the report's own fields and scrubbed like every other artifact. If the scrub still
 * finds a secret after redaction, the issue carries only the outcome and a link to the run, never the message.
 *
 * The transport is `node:https` through Node's default connect path, so a test can serve a strict local TLS
 * fake of GitHub's API and hand its certificate in as `ca`. The token goes only in the Authorization header.
 */
import https from "node:https";
import { ISSUE_LABEL, issueTitle, scrubbedText, type PackResult, type Results } from "./report.js";
import type { ScrubContext } from "./scrub.js";

export const NEEDS_OWNER_LABEL = "needs-owner";
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const MAX_LIST_PAGES = 10;
const MAX_ERROR_CHARS = 300;

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

export interface IssueOptions {
  /** `owner/name` of the repository whose Issues are used (the repo that runs the workflow). */
  repo: string;
  token: string;
  /** Default `https://api.github.com`. Must be https. */
  apiBase?: string;
  /** Extra trust root for a local TLS fake. Never a way to turn certificate checks off. */
  ca?: string;
  runUrl?: string;
  scrub: ScrubContext;
}

export interface IssueAction {
  pack: string;
  action: "created" | "commented" | "closed" | "none";
  number?: number;
}

interface IssueRow {
  number: number;
  title: string;
  body?: string | null;
  pull_request?: unknown;
}

/** One GitHub API call over https (Node's default connect path). Exported so other GitHub reads in this package share it. */
export function request(opts: Pick<IssueOptions, "token" | "apiBase" | "ca">, method: string, path: string, body?: unknown): Promise<unknown> {
  const base = new URL(opts.apiBase ?? "https://api.github.com");
  if (base.protocol !== "https:") throw new GithubError("the GitHub API address must be https", 0);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${opts.token}`,
    "user-agent": "live-e2e",
    "x-github-api-version": "2022-11-28",
  };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      { protocol: "https:", hostname: base.hostname, port: base.port || 443, method, path, headers, ...(opts.ca !== undefined ? { ca: opts.ca } : {}), timeout: 30_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          // Never echo the response body: only its status.
          if (status < 200 || status >= 300) return reject(new GithubError(`GitHub answered ${status} for ${method} ${path.split("?")[0]}`, status));
          try {
            resolve(text === "" ? null : JSON.parse(text));
          } catch {
            reject(new GithubError(`GitHub sent a body that is not JSON for ${method} ${path.split("?")[0]}`, status));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new GithubError("GitHub request timed out", 0)));
    req.on("error", reject);
    req.end(payload);
  });
}

async function openIssues(opts: Pick<IssueOptions, "repo" | "token" | "apiBase" | "ca">): Promise<IssueRow[]> {
  const all: IssueRow[] = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const rows = (await request(opts, "GET", `/repos/${opts.repo}/issues?labels=${ISSUE_LABEL}&state=open&per_page=100&page=${page}`)) as IssueRow[];
    all.push(...rows.filter((r) => r.pull_request === undefined));
    if (rows.length < 100) break;
  }
  return all;
}

/** A failed pack: a test failed, or the budget abort stopped it. A refusal, a skip or a flaky pass is not a failure. */
export function isFailure(p: PackResult): boolean {
  return p.outcome === "FAIL" || p.outcome === "ABORTED-BUDGET";
}

function failureBody(p: PackResult, results: Results, runUrl: string | undefined, withDetail: boolean): string {
  const lines = [`Pack \`${p.id}\` on \`${results.target}\`: ${p.outcome}.`, ""];
  if (runUrl !== undefined) lines.push(`Run: ${runUrl}`);
  if (results.commit !== null) lines.push(`Commit: ${results.commit}`);
  if (withDetail) {
    for (const t of (p.tests ?? []).filter((x) => x.status === "failed")) {
      const msg = (t.error ?? "").split("\n")[0]?.slice(0, MAX_ERROR_CHARS) ?? "";
      lines.push(`- ${t.title} (${t.device})${msg === "" ? "" : `: ${msg}`}`);
    }
  }
  return lines.join("\n");
}

function safeBody(p: PackResult, results: Results, opts: IssueOptions): string {
  try {
    return scrubbedText(failureBody(p, results, opts.runUrl, true), opts.scrub);
  } catch {
    // A secret survived redaction: say nothing about the failure beyond the pack, target and run.
    return failureBody(p, results, opts.runUrl, false) + "\n\n(Failure detail left out: it still looked like a secret after redaction.)";
  }
}

export async function syncIssues(results: Results, opts: IssueOptions): Promise<IssueAction[]> {
  if (!REPO_PATTERN.test(opts.repo)) throw new GithubError("repo must be owner/name", 0);
  const open = await openIssues(opts);
  const actions: IssueAction[] = [];
  for (const p of results.packs) {
    const title = issueTitle(p.id, results.target);
    const existing = open.filter((i) => i.title === title).sort((a, b) => a.number - b.number)[0];
    const production = results.target === "production";
    if (isFailure(p)) {
      const body = safeBody(p, results, opts);
      if (existing === undefined) {
        const labels = production ? [ISSUE_LABEL, NEEDS_OWNER_LABEL] : [ISSUE_LABEL];
        const made = (await request(opts, "POST", `/repos/${opts.repo}/issues`, { title, body, labels })) as { number: number };
        actions.push({ pack: p.id, action: "created", number: made.number });
      } else {
        await request(opts, "POST", `/repos/${opts.repo}/issues/${existing.number}/comments`, { body });
        if (production) await request(opts, "POST", `/repos/${opts.repo}/issues/${existing.number}/labels`, { labels: [NEEDS_OWNER_LABEL] });
        actions.push({ pack: p.id, action: "commented", number: existing.number });
      }
    } else if (p.outcome === "PASS" && existing !== undefined) {
      await request(opts, "POST", `/repos/${opts.repo}/issues/${existing.number}/comments`, { body: `Green again${results.commit !== null ? ` on ${results.commit}` : ""}.${opts.runUrl !== undefined ? ` Run: ${opts.runUrl}` : ""}` });
      await request(opts, "PATCH", `/repos/${opts.repo}/issues/${existing.number}`, { state: "closed", state_reason: "completed" });
      actions.push({ pack: p.id, action: "closed", number: existing.number });
    } else {
      actions.push({ pack: p.id, action: "none" });
    }
  }
  return actions;
}

export const sessionIssueTitle = (role: string): string => `live-e2e: session lapsed (${role})`;

/**
 * The fixed list of lapse reasons (R-441-T3-18). The code, never the wording, is what the issue body records and what a
 * later check compares: jobs share no memory, so the open issue is the only place the last reason can live.
 */
export const LAPSE_REASON_CODES = { lapsed: "idle", expired: "past-limit", malformed: "malformed", rejected: "app-rejected" } as const;
export const REASON_LINE_PREFIX = "Reason code: ";
const REASON_LINE = new RegExp(`^${REASON_LINE_PREFIX}([a-z0-9-]{1,32})$`, "m");

/** The reason code for a keep-alive state; a state outside the list is `other` (it still opens, and compares, as one reason). */
export const lapseReasonCode = (state: string): string => (LAPSE_REASON_CODES as Record<string, string>)[state] ?? "other";

/** The reason code an open issue body records, or undefined when it has none (an issue from before the line existed). */
export const reasonCodeOf = (body: string | null | undefined): string | undefined => REASON_LINE.exec(body ?? "")?.[1];

export interface SessionIssueEvent {
  role: string;
  /** The keep-alive state (a closed set of words, never a cookie). */
  state: string;
  lapsed: boolean;
}

/**
 * One issue per lapsed role, never one per pack that needed it (4a): opened with `live-e2e` + `needs-owner` and
 * the capture command; while the role stays lapsed for the same reason nothing is added (the keep-alive runs every
 * few hours), and when the reason changes the issue is updated and commented on; closed once the role is healthy again. A role that is not in `events` (never captured, or forgotten) is left alone.
 */
export async function syncSessionIssues(
  events: SessionIssueEvent[],
  opts: Pick<IssueOptions, "repo" | "token" | "apiBase" | "ca" | "runUrl"> & { captureCommand: (role: string) => string },
): Promise<IssueAction[]> {
  if (!REPO_PATTERN.test(opts.repo)) throw new GithubError("repo must be owner/name", 0);
  const open = await openIssues(opts);
  const actions: IssueAction[] = [];
  for (const e of events) {
    const title = sessionIssueTitle(e.role);
    const existing = open.filter((i) => i.title === title).sort((a, b) => a.number - b.number)[0];
    const pack = `session:${e.role}`;
    if (e.lapsed) {
      const headline = `The stored session for \`${e.role}\` is no longer usable (${e.state}). Packs that need it report SKIPPED-NEED until it is captured again.`;
      const code = lapseReasonCode(e.state);
      const body = [headline, "", `${REASON_LINE_PREFIX}${code}`, "", `Capture it again on the owner's machine: \`${opts.captureCommand(e.role)}\``, ...(opts.runUrl !== undefined ? ["", `Run: ${opts.runUrl}`] : [])].join("\n");
      if (existing === undefined) {
        const made = (await request(opts, "POST", `/repos/${opts.repo}/issues`, { title, body, labels: [ISSUE_LABEL, NEEDS_OWNER_LABEL] })) as { number: number };
        actions.push({ pack, action: "created", number: made.number });
      } else if (reasonCodeOf(existing.body) !== code) {
        // Compared on the machine-readable line only, so the wording around it can change without re-commenting every open issue.
        await request(opts, "PATCH", `/repos/${opts.repo}/issues/${existing.number}`, { body });
        await request(opts, "POST", `/repos/${opts.repo}/issues/${existing.number}/comments`, { body: `Still lapsed, now: ${e.state}.${opts.runUrl !== undefined ? ` Run: ${opts.runUrl}` : ""}` });
        actions.push({ pack, action: "commented", number: existing.number });
      } else {
        actions.push({ pack, action: "none", number: existing.number });
      }
    } else if (e.state === "ok" && existing !== undefined) {
      await request(opts, "POST", `/repos/${opts.repo}/issues/${existing.number}/comments`, { body: "The session is usable again." });
      await request(opts, "PATCH", `/repos/${opts.repo}/issues/${existing.number}`, { state: "closed", state_reason: "completed" });
      actions.push({ pack, action: "closed", number: existing.number });
    } else {
      actions.push({ pack, action: "none" });
    }
  }
  return actions;
}

export const STORE_ISSUE_TITLE = "live-e2e: session store unreadable";

/**
 * A store that cannot be read (a rotated key, an edited or corrupt file) is one issue with the way out, not a crash and
 * not one issue per pack; it closes itself the first time the store reads again.
 */
export async function syncStoreIssue(
  unreadable: boolean,
  opts: Pick<IssueOptions, "repo" | "token" | "apiBase" | "ca" | "runUrl"> & { why: string; recapture: string },
): Promise<IssueAction> {
  if (!REPO_PATTERN.test(opts.repo)) throw new GithubError("repo must be owner/name", 0);
  const existing = (await openIssues(opts)).filter((i) => i.title === STORE_ISSUE_TITLE).sort((a, b) => a.number - b.number)[0];
  const pack = "session-store";
  if (unreadable && existing === undefined) {
    const body = [`The encrypted session store cannot be read (${opts.why}). Every pack that needs a session reports SKIPPED-NEED until it is fixed.`, "", opts.recapture, ...(opts.runUrl !== undefined ? ["", `Run: ${opts.runUrl}`] : [])].join("\n");
    const made = (await request(opts, "POST", `/repos/${opts.repo}/issues`, { title: STORE_ISSUE_TITLE, body, labels: [ISSUE_LABEL, NEEDS_OWNER_LABEL] })) as { number: number };
    return { pack, action: "created", number: made.number };
  }
  if (!unreadable && existing !== undefined) {
    await request(opts, "POST", `/repos/${opts.repo}/issues/${existing.number}/comments`, { body: "The session store reads again." });
    await request(opts, "PATCH", `/repos/${opts.repo}/issues/${existing.number}`, { state: "closed", state_reason: "completed" });
    return { pack, action: "closed", number: existing.number };
  }
  return { pack, action: "none", ...(existing !== undefined ? { number: existing.number } : {}) };
}

// ---------------------------------------------------------------------------------------------------------
// The team-log line (T2c, G4)

export const TEAM_LOG_LABEL = "team-log";
/** Runs that post a team-log line: the unattended ones. An owner dispatch is watched by the person who started it. */
export const TEAM_LOG_TRIGGERS = ["deploy", "poll", "nightly", "weekly", "keepalive"] as const;
const PLAIN_WORD = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PLAIN_PACK = /^[a-z0-9][a-z0-9:_-]{0,79}$/;

export interface TeamLogEvent {
  target: string;
  /** `smoke`, `standard`, `full`, or `none` for the session keep-alive. */
  tier: string;
  trigger: string;
  /** Failing pack ids, or `session:<role>` for a lapse. */
  packs: string[];
  runUrl?: string | undefined;
}

/** True when this run should leave a line: an unattended trigger with something to report. */
export const wantsTeamLog = (trigger: string | null | undefined, packs: readonly string[]): boolean =>
  trigger !== null && trigger !== undefined && (TEAM_LOG_TRIGGERS as readonly string[]).includes(trigger) && packs.length > 0;

/** The pack ids of a run that need a line: the failed ones (a skip, a flaky pass and a refusal are not). */
export const failingPackIds = (results: Results): string[] => results.packs.filter(isFailure).map((p) => p.id);

function plain(value: string, pattern: RegExp): string {
  return pattern.test(value) ? value : "?";
}

function plainUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !/\s/.test(value) ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One line, in the team log's own format: `[HH:MM] live-e2e: ...`. Every field is checked to be a plain word (a pack id,
 * a target, a URL) before it goes in, so nothing free-form such as a failure message reaches the line at all; then the
 * whole line goes through the same scrub as every other artifact. If the scrub still finds a secret, the pack ids and
 * run link are dropped and only the outcome is said.
 */
export function teamLogLine(ev: TeamLogEvent, scrub: ScrubContext, at: Date): string {
  const hhmm = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
  const head = `[${hhmm}] live-e2e: red`;
  const fields = [`target=${plain(ev.target, PLAIN_WORD)}`, `tier=${plain(ev.tier, PLAIN_WORD)}`, `trigger=${plain(ev.trigger, PLAIN_WORD)}`];
  const packs = ev.packs.map((p) => plain(p, PLAIN_PACK)).join(",");
  const url = plainUrl(ev.runUrl);
  const full = `${head} ${[...fields, `packs=${packs}`, ...(url !== undefined ? [`run=${url}`] : [])].join(" ")}`;
  try {
    return scrubbedText(full, scrub);
  } catch {
    return `${head} ${fields.join(" ")} (pack ids and run link left out: they still looked like a secret after redaction)`;
  }
}

export interface TeamLogOptions extends Pick<IssueOptions, "repo" | "token" | "apiBase" | "ca" | "scrub"> {
  now?: () => number;
  /** Where the fallback line goes (the job summary). Called with the line only. */
  summary?: (line: string) => void;
}

export interface TeamLogResult {
  where: "issue" | "summary";
  number?: number;
}

/**
 * Posts the line as a comment on the open `team-log` issue. With no such issue, or when GitHub refuses the call,
 * the line goes to the job summary instead and nothing throws: a missing log must never turn a red run into a broken
 * workflow step.
 */
export async function postTeamLog(ev: TeamLogEvent, opts: TeamLogOptions): Promise<TeamLogResult> {
  if (!REPO_PATTERN.test(opts.repo)) throw new GithubError("repo must be owner/name", 0);
  const line = teamLogLine(ev, opts.scrub, new Date((opts.now ?? Date.now)()));
  try {
    const rows = (await request(opts, "GET", `/repos/${opts.repo}/issues?labels=${TEAM_LOG_LABEL}&state=open&per_page=30`)) as IssueRow[];
    const log = rows.filter((r) => r.pull_request === undefined).sort((a, b) => a.number - b.number)[0];
    if (log !== undefined) {
      await request(opts, "POST", `/repos/${opts.repo}/issues/${log.number}/comments`, { body: line });
      return { where: "issue", number: log.number };
    }
  } catch (err) {
    if (!(err instanceof GithubError)) throw err;
  }
  opts.summary?.(`No open team-log issue could be written to; the line is here instead: ${line}`);
  return { where: "summary" };
}
