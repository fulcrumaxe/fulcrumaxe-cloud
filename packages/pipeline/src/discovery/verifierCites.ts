import { parseFileRef } from "@fx/core/src/plan/proposalVerification.js";
import type { Cite, VerifierClaim } from "./verifierOutput.js";

/**
 * D#483 S4-b1: the system, not the model, makes the evidence.
 *
 * For every cite a claim names, the file is read at the pinned commit through the GitHub contents API (hosted) or the runner's
 * checkout (runner; both sit behind `FileReader`), the lines are confirmed to exist, and the excerpt STORED is the bytes read,
 * never text the model returned. A cite that fails makes its claim `refuted` with `cite_not_found`.
 *
 * A read that FAILS (GitHub down, a bad answer) throws `CiteReadError`; it is never "not found". The caller turns it into
 * `check_failed`, so an outage cannot refute a true claim.
 *
 * Bounds that cap the cost of one verification: at most MAX_NEW_CLAIMS x MAX_CITES_PER_CLAIM cites (verifierOutput.ts), each
 * file read once per run, an excerpt of at most MAX_EXCERPT_CHARS characters, one fixed host, one pinned sha.
 */
export const MAX_EXCERPT_CHARS = 600;
/** Largest file the reader is asked to return. */
export const MAX_CITE_FILE_BYTES = 1024 * 1024;
export const MAX_EVIDENCE_ROWS = 30;

export class CiteReadError extends Error {
  constructor() {
    super("cite read failed");
    this.name = "CiteReadError";
  }
}

/** The file's text at `sha`, or null when the path does not exist there. Throws `CiteReadError` for any other failure. */
export interface FileReader {
  readFile(path: string, sha: string): Promise<string | null>;
}

/** The shape of `PlanReadClient.request` in @fx/github, narrowed to what a contents read needs. */
export type ContentsRequester = (req: {
  method: "GET";
  path: string;
  query: { ref: string };
  accept: string;
  maxBytes: number;
}) => Promise<{ status: number; text: string }>;

const GITHUB_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** A FileReader over the GitHub contents API: `GET /repos/{owner}/{name}/contents/{path}?ref={sha}` with the object media type (only a regular file is accepted). */
export function fileReaderFromContents(request: ContentsRequester, repo: { owner: string; name: string }): FileReader {
  if (!GITHUB_NAME_RE.test(repo.owner) || !GITHUB_NAME_RE.test(repo.name)) throw new Error("fileReaderFromContents: not a GitHub name");
  return {
    async readFile(path, sha) {
      if (!SHA_RE.test(sha)) throw new Error("fileReaderFromContents: ref must be a full commit sha");
      let res: { status: number; text: string };
      try {
        res = await request({
          method: "GET",
          path: `/repos/${repo.owner}/${repo.name}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
          query: { ref: sha },
          accept: "application/vnd.github.object+json",
          maxBytes: MAX_CITE_FILE_BYTES,
        });
      } catch {
        // fx-swallow-ok: any transport failure is one fixed code; the cause is not an input to a verdict
        throw new CiteReadError();
      }
      if (res.status === 404) return null;
      if (res.status !== 200) throw new CiteReadError();
      return regularFileText(res.text);
    },
  };
}

/**
 * The text of a regular file from the object form of the contents answer, or null for anything else. A directory, a submodule and a
 * symlink also answer 200 (with metadata that can carry download links), so only `type: "file"` with base64 content is accepted.
 * An oversize file (encoding "none", empty content) is not readable here either.
 */
function regularFileText(body: string): string | null {
  let o: unknown;
  try {
    o = JSON.parse(body);
  } catch {
    // fx-swallow-ok: a non-JSON answer is GitHub misbehaving, not a file
    throw new CiteReadError();
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new CiteReadError();
  const r = o as Record<string, unknown>;
  if (r.type !== "file") return null;
  if (r.encoding !== "base64" || typeof r.content !== "string") return null;
  const b64 = r.content.replace(/\n/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new CiteReadError();
  return Buffer.from(b64, "base64").toString("utf8");
}

// Control characters the evidence column refuses (tab, newline and carriage return are allowed). NUL cannot be stored in Postgres text.
const EVIDENCE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export interface EvidenceRow {
  kind: "file_lines";
  ref: string;
  excerpt: string;
  commit_sha: string;
}

/** The text of lines `start..end` (1-based, inclusive) as the file holds it, or null when the file is shorter, or the lines are blank or not plain text. */
export function excerptOf(text: string, start: number, end: number): string | null {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // a final newline ends the last line; it does not start another
  if (start < 1 || end < start || end > lines.length) return null;
  const excerpt = Array.from(lines.slice(start - 1, end).join("\n")).slice(0, MAX_EXCERPT_CHARS).join("");
  if (excerpt.trim() === "" || EVIDENCE_CONTROL.test(excerpt)) return null;
  return excerpt;
}

/** `<path>:<start>-<end>`, or `<path>:<line>` for one line: the grammar the read side parses. */
export function citeRef(c: Cite): string {
  return c.start_line === c.end_line ? `${c.path}:${c.start_line}` : `${c.path}:${c.start_line}-${c.end_line}`;
}

export type ResolvedVerdict = "supported" | "refuted" | "unverifiable";
export interface ResolvedClaim {
  text: string;
  verdict: ResolvedVerdict;
  refute_code?: "cite_not_found" | "contradicted";
}

/**
 * Reads every cite of every claim and decides each claim's recorded verdict.
 *  - `unverifiable`, or `supported`/`refuted` with no cite: `unverifiable` (the system has nothing to confirm), no read.
 *  - any cite that does not resolve: `refuted` / `cite_not_found`, and none of that claim's evidence is kept.
 *  - all cites resolve: the model's verdict stands (`refuted` is recorded as `contradicted`), and the excerpts become evidence.
 */
export async function resolveClaims(
  reader: FileReader,
  sha: string,
  claims: readonly VerifierClaim[],
): Promise<{ claims: ResolvedClaim[]; evidence: EvidenceRow[] }> {
  const files = new Map<string, Promise<string | null>>();
  const read = (path: string): Promise<string | null> => {
    let p = files.get(path);
    if (p === undefined) files.set(path, (p = reader.readFile(path, sha)));
    return p;
  };
  const out: ResolvedClaim[] = [];
  const evidence = new Map<string, EvidenceRow>();
  for (const claim of claims) {
    if (claim.verdict === "unverifiable" || claim.cites.length === 0) {
      out.push({ text: claim.text, verdict: "unverifiable" });
      continue;
    }
    const rows: EvidenceRow[] = [];
    for (const cite of claim.cites) {
      const ref = citeRef(cite);
      const parsed = parseFileRef(ref);
      const text = parsed !== null && parsed.path === cite.path ? await read(cite.path) : null;
      const excerpt = text === null ? null : excerptOf(text, cite.start_line, cite.end_line);
      if (excerpt === null) {
        rows.length = 0;
        break;
      }
      rows.push({ kind: "file_lines", ref, excerpt, commit_sha: sha });
    }
    if (rows.length === 0) {
      out.push({ text: claim.text, verdict: "refuted", refute_code: "cite_not_found" });
      continue;
    }
    for (const r of rows) if (evidence.size < MAX_EVIDENCE_ROWS) evidence.set(r.ref, r);
    out.push(claim.verdict === "refuted" ? { text: claim.text, verdict: "refuted", refute_code: "contradicted" } : { text: claim.text, verdict: "supported" });
  }
  return { claims: out, evidence: [...evidence.values()] };
}
