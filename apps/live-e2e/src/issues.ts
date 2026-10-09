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
  pull_request?: unknown;
}

function request(opts: IssueOptions, method: string, path: string, body?: unknown): Promise<unknown> {
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

async function openIssues(opts: IssueOptions): Promise<IssueRow[]> {
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
