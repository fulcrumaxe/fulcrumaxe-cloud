import { Claim, type ClaimType, type EvidenceType } from "@fx/sitekit-claims";
import type { ExtractedClaim } from "../extract/index.js";

/** What a read of one file at the pinned sha comes back as. The port answers; it never decides a verdict. */
export type RepoFile = { kind: "text"; text: string } | { kind: "missing" } | { kind: "binary" } | { kind: "too_large" };

/**
 * Reads files from the repository at the pinned sha (the same checkout the passes work on). A file it cannot
 * return is an answer (`missing`, `binary`, `too_large`); a throw means the read itself failed.
 */
export interface RepoReader {
  read(sha: string, path: string): Promise<RepoFile>;
}

/** A cited file longer than this (in UTF-16 units) is not searched, whatever the adapter says about its size. */
export const MAX_CITED_FILE_CHARS = 1_000_000;

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A plain repository-relative path: no leading slash, no backslash, no NUL, no empty, "." or ".." segment. */
export function isPlainRepoPath(p: string): boolean {
  return p.length > 0 && p.length <= 300 && !p.includes("\\") && !p.includes("\0") && !p.startsWith("/") && !p.split("/").some((s) => s === "" || s === "." || s === "..");
}

type Outcome = "ok" | "conflict" | "unverifiable";

function holds(text: string, excerpt: string, lines?: { start: number; end: number }): boolean {
  const scope = lines === undefined ? text : text.split(/\r?\n/).slice(lines.start - 1, lines.end).join("\n");
  return norm(scope).includes(norm(excerpt));
}

/**
 * A claim the verifier called VERIFIED stands only if every excerpt it keeps is really in the cited file at the
 * pinned sha, inside the cited lines when there are any (the verifier's own, and those of the extractor's matching
 * cite, so leaving the lines out cannot widen the search). Same whitespace-run rule as the evidence match, nothing looser.
 *
 * Verdict choice: an excerpt that is not there, a missing, binary or oversized file, or a path that is not a plain
 * repository path means the evidence the verifier handed us does not check out. That is the same case as evidence
 * matching nothing the extractor cited, so CONFLICT (it blocks, and a person or a fix step looks). A read that
 * itself fails says nothing about the claim, so UNVERIFIABLE: not rendered, nothing is asserted either way.
 * Both are fail-closed; only a found excerpt keeps VERIFIED.
 */
export async function confirmExcerpts(
  extracted: readonly ExtractedClaim[],
  decided: readonly ClaimType[],
  repo: RepoReader,
  sha: string,
): Promise<ClaimType[]> {
  const asked = new Map(extracted.map((c) => [c.id, c]));
  const files = new Map<string, Promise<RepoFile | "failed">>();
  const load = (path: string): Promise<RepoFile | "failed"> => {
    let f = files.get(path);
    if (f === undefined) {
      f = repo.read(sha, path).catch(() => "failed" as const);
      files.set(path, f);
    }
    return f;
  };
  const check = async (e: EvidenceType, cites: readonly EvidenceType[]): Promise<Outcome> => {
    if (!isPlainRepoPath(e.path)) return "conflict";
    const file = await load(e.path);
    if (file === "failed") return "unverifiable";
    if (file.kind !== "text") return "conflict";
    if (file.text.length > MAX_CITED_FILE_CHARS || file.text.includes("\0")) return "conflict";
    const ranges = [e.lines, ...cites.filter((c) => c.path === e.path && norm(c.excerpt) === norm(e.excerpt)).map((c) => c.lines)];
    return ranges.every((r) => holds(file.text, e.excerpt, r)) ? "ok" : "conflict";
  };
  const out: ClaimType[] = [];
  for (const c of decided) {
    const source = asked.get(c.id);
    if (c.verdict !== "VERIFIED" || source === undefined) {
      out.push(c);
      continue;
    }
    const outcomes = await Promise.all(c.evidence.map((e) => check(e, source.evidence)));
    const worst: Outcome = outcomes.includes("conflict") ? "conflict" : outcomes.includes("unverifiable") ? "unverifiable" : "ok";
    if (worst === "ok") out.push(c);
    else out.push(Claim.parse({ ...c, verdict: worst === "conflict" ? "CONFLICT" : "UNVERIFIABLE", evidence: source.evidence }));
  }
  return out;
}
