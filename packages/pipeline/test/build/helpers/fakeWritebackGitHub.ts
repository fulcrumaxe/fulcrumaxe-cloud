import { createHash } from "node:crypto";
import type { WritebackHttp, WritebackHttpRequest } from "../../../src/build/planWritebackGitHub.js";

/**
 * A GitHub REST fake for the plan write-back, at the HTTP layer, so the real port (createWritebackGitHub) runs against it. It enforces
 * what the real API enforces that the write-back touches:
 *   - a blob sha that is the git blob hash of the file's bytes, and a PUT to the contents API that must name the file's CURRENT blob on
 *     that branch (409 otherwise);
 *   - creating a ref that exists answers 422; deleting a ref that does not answers 422; reading one that does not answers 404;
 *   - a PUT to the contents API commits on whatever the branch tip is AT THAT MOMENT (the blob check does not look at the tip), and the
 *     response carries the new commit's `parents`, as the real API does; a test makes another identity push in between with `onRequest`;
 *   - the three-dot compare (`base...head`): merge base, ahead/behind counts, the files that differ and the commit messages;
 *   - a pull request needs an existing head branch (422), a second open pull request for the same head and base answers 422, and a
 *     pull request whose head has no commit the base lacks answers 422 "No commits between" (as the real pulls API does);
 *   - every commit carries an author and a committer email: commits made through the contents API are the App's (APP_EMAIL), commits a
 *     test makes with `pushAs` are a person's (PERSON_EMAIL) unless the test says otherwise; the compare response carries both;
 *   - the default branch is protected: any write that names it answers 403 (and is recorded in `denied`);
 *   - a file over about 1 MB is not inlined by the contents API (encoding "none", empty content).
 * It cannot reproduce: installation tokens and their permissions, secondary rate limits, abuse detection, or branch rules beyond the above.
 */
export const APP_EMAIL = "123456+fulcrumaxe[bot]@users.noreply.github.com";
export const PERSON_EMAIL = "dev@example.com";
export const OWNER = "acme";
export const NAME = "plans";

interface Commit {
  sha: string;
  parent: string | null;
  files: Map<string, string>;
  message: string;
  email: string;
}
interface Pr {
  number: number;
  head: string;
  base: string;
  state: "open" | "closed";
  merged: boolean;
}

const gitBlob = (text: string): string => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

export class FakeGitHub {
  readonly defaultBranch = "main";
  private commits = new Map<string, Commit>();
  private refs = new Map<string, string>();
  prs: Pr[] = [];
  denied: string[] = [];
  /** Runs at the start of every request, before it is handled: a test makes someone else act between the platform's steps here. */
  onRequest: ((req: WritebackHttpRequest) => void) | null = null;
  /** Every request that reached the fake, as "METHOD /path", so a test can assert what was (not) called. */
  readonly calls: string[] = [];
  private counter = 0;

  constructor(initial: Record<string, string>) {
    this.refs.set(this.defaultBranch, this.commit(null, new Map(Object.entries(initial)), "initial").sha);
  }

  private commit(parent: string | null, files: Map<string, string>, message: string, email = PERSON_EMAIL): Commit {
    this.counter += 1;
    const sha = createHash("sha1").update(`commit ${this.counter} ${parent ?? ""} ${[...files].join("|")}`).digest("hex");
    const c = { sha, parent, files, message, email };
    this.commits.set(sha, c);
    return c;
  }

  // ---- test controls (what other people do) ---------------------------------------------------------------------------------
  tip(branch = this.defaultBranch): string {
    return this.refs.get(branch)!;
  }
  file(path: string, ref = this.defaultBranch): string | undefined {
    return this.commits.get(this.refs.get(ref) ?? ref)?.files.get(path);
  }
  branches(): string[] {
    return [...this.refs.keys()].sort();
  }
  /** Someone else pushes a commit changing `path` to `branch`. */
  pushAs(branch: string, path: string, text: string, message = "someone else's change", email = PERSON_EMAIL): string {
    const parent = this.commits.get(this.refs.get(branch)!)!;
    const c = this.commit(parent.sha, new Map([...parent.files, [path, text]]), message, email);
    this.refs.set(branch, c.sha);
    return c.sha;
  }
  /** A person merges the pull request: its file content lands on the default branch in one new commit. */
  merge(prNumber: number): void {
    const pr = this.prs.find((p) => p.number === prNumber)!;
    const head = this.commits.get(this.refs.get(pr.head)!)!;
    const base = this.commits.get(this.refs.get(pr.base)!)!;
    const c = this.commit(base.sha, new Map([...base.files, ...head.files]), "merge");
    this.refs.set(pr.base, c.sha);
    pr.state = "closed";
    pr.merged = true;
  }
  /** A person closes the pull request without merging. */
  closeUnmerged(prNumber: number): void {
    this.prs.find((p) => p.number === prNumber)!.state = "closed";
  }
  /** Someone else changes the default branch (another merge). */
  pushDefault(path: string, text: string): void {
    this.pushAs(this.defaultBranch, path, text);
  }
  inlineLimit = 1_000_000;

  private chain(sha: string): string[] {
    const out: string[] = [];
    for (let c: Commit | undefined = this.commits.get(sha); c; c = c.parent ? this.commits.get(c.parent) : undefined) out.push(c.sha);
    return out;
  }

  // ---- the API --------------------------------------------------------------------------------------------------------------
  readonly http: WritebackHttp = {
    request: async (req) => this.handle(req),
  };

  private prJson(p: Pr): Record<string, unknown> {
    return {
      number: p.number,
      state: p.state,
      merged: p.merged,
      draft: false,
      head: { ref: p.head, sha: this.refs.get(p.head) ?? "0".repeat(40), repo: { full_name: `${OWNER}/${NAME}` } },
      base: { ref: p.base, repo: { full_name: `${OWNER}/${NAME}` } },
    };
  }

  private handle(req: WritebackHttpRequest): { status: number; body: unknown } {
    this.onRequest?.(req);
    this.calls.push(`${req.method} ${req.path}${req.query ? `?${new URLSearchParams(req.query as Record<string, string>)}` : ""}`);
    const repo = `/repos/${OWNER}/${NAME}`;
    if (!req.path.startsWith(`${repo}/`)) return { status: 404, body: { message: "Not Found" } };
    const rest = req.path.slice(repo.length);
    const body = (req.body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;

    if (req.method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = this.refs.get(decodeURIComponent(m[1]!));
      return sha ? { status: 200, body: { object: { sha } } } : { status: 404, body: { message: "Not Found" } };
    }
    if (req.method === "POST" && rest === "/git/refs") {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (name === this.defaultBranch) return this.deny(req);
      if (this.refs.has(name)) return { status: 422, body: { message: "Reference already exists" } };
      if (!this.commits.has(String(body.sha))) return { status: 422, body: { message: "Object does not exist" } };
      this.refs.set(name, String(body.sha));
      return { status: 201, body: { ref: body.ref } };
    }
    if (req.method === "DELETE" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const name = decodeURIComponent(m[1]!);
      if (name === this.defaultBranch) return this.deny(req);
      if (!this.refs.has(name)) return { status: 422, body: { message: "Reference does not exist" } };
      this.refs.delete(name);
      return { status: 204, body: null };
    }
    if (req.method === "GET" && (m = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest))) {
      const a = this.chain(m[1]!);
      const b = this.chain(m[2]!);
      if (a.length === 0 || b.length === 0) return { status: 404, body: { message: "Not Found" } };
      const base = b.find((sha) => a.includes(sha));
      if (!base) return { status: 404, body: { message: "No common ancestor" } };
      const baseFiles = this.commits.get(base)!.files;
      const headFiles = this.commits.get(m[2]!)!.files;
      const files = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].filter((f) => baseFiles.get(f) !== headFiles.get(f)).sort();
      const mine = b.slice(0, b.indexOf(base)).reverse();
      return {
        status: 200,
        body: {
          ahead_by: mine.length,
          behind_by: a.indexOf(base),
          merge_base_commit: { sha: base },
          files: files.map((filename) => ({ filename })),
          commits: mine.map((sha) => {
            const c = this.commits.get(sha)!;
            return { sha, commit: { message: c.message, author: { email: c.email }, committer: { email: c.email } } };
          }),
        },
      };
    }
    if (req.method === "GET" && (m = /^\/contents\/(.+)$/.exec(rest))) {
      const path = decodeURIComponent(m[1]!);
      const ref = String(req.query?.ref ?? this.defaultBranch);
      const c = this.commits.get(this.refs.get(ref) ?? ref);
      const text = c?.files.get(path);
      if (text === undefined) return { status: 404, body: { message: "Not Found" } };
      const big = Buffer.byteLength(text) > this.inlineLimit;
      return {
        status: 200,
        body: { type: "file", sha: gitBlob(text), size: Buffer.byteLength(text), encoding: big ? "none" : "base64", content: big ? "" : Buffer.from(text).toString("base64").replace(/(.{60})/g, "$1\n") },
      };
    }
    if (req.method === "PUT" && (m = /^\/contents\/(.+)$/.exec(rest))) {
      const path = decodeURIComponent(m[1]!);
      const branch = String(body.branch);
      if (branch === this.defaultBranch) return this.deny(req);
      const tip = this.refs.get(branch);
      if (!tip) return { status: 404, body: { message: "Branch not found" } };
      const parent = this.commits.get(tip)!;
      const current = parent.files.get(path);
      if (current !== undefined && body.sha !== gitBlob(current)) return { status: 409, body: { message: `${path} does not match ${String(body.sha)}` } };
      if (current === undefined && body.sha !== undefined) return { status: 422, body: { message: "sha was supplied but the file does not exist" } };
      const c = this.commit(parent.sha, new Map([...parent.files, [path, Buffer.from(String(body.content), "base64").toString("utf8")]]), String(body.message), APP_EMAIL);
      this.refs.set(branch, c.sha);
      return { status: 200, body: { commit: { sha: c.sha, parents: [{ sha: parent.sha }] }, content: { sha: gitBlob(c.files.get(path)!) } } };
    }
    if (req.method === "POST" && rest === "/pulls") {
      const head = String(body.head);
      const base = String(body.base);
      if (!this.refs.has(head) || !this.refs.has(base)) return { status: 422, body: { message: "Validation Failed" } };
      if (this.chain(this.refs.get(head)!).every((sha) => this.chain(this.refs.get(base)!).includes(sha))) return { status: 422, body: { message: "Validation Failed: No commits between base and head" } };
      if (this.prs.some((p) => p.state === "open" && p.head === head && p.base === base)) return { status: 422, body: { message: "A pull request already exists" } };
      const pr: Pr = { number: 100 + this.prs.length + 1, head, base, state: "open", merged: false };
      this.prs.push(pr);
      return { status: 201, body: this.prJson(pr) };
    }
    if (req.method === "GET" && rest === "/pulls") {
      const want = String(req.query?.head ?? "").replace(`${OWNER}:`, "");
      return { status: 200, body: this.prs.filter((p) => p.head === want).map((p) => this.prJson(p)) };
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pr = this.prs.find((p) => p.number === Number(m![1]));
      if (!pr) return { status: 404, body: { message: "Not Found" } };
      if (req.method === "GET") return { status: 200, body: this.prJson(pr) };
      if (req.method === "PATCH") {
        if (body.state === "closed") pr.state = "closed";
        return { status: 200, body: this.prJson(pr) };
      }
    }
    return { status: 404, body: { message: "Not Found" } };
  }

  private deny(req: WritebackHttpRequest): { status: number; body: unknown } {
    this.denied.push(`${req.method} ${req.path}`);
    return { status: 403, body: { message: "Protected branch" } };
  }
}
