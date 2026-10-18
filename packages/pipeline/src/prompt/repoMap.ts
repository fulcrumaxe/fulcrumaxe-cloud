import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";

/**
 * D#600 CX-3a: the repository map the executor's prompt carries, built on the CLOUD side (never inside the sandbox) from GitHub's git
 * trees API at the commit the run starts from. No model call: the text is a pure function of the tree, so it is the same for the same
 * commit. It holds the file paths down to a depth cap (deeper files fold into their folder with a count), each package manifest's name
 * and scripts, and the detected test command, and it is cut to REPO_MAP_MAX_BYTES with a marker. `assemblePrompt` puts it in the
 * untrusted-content fence (a path is repository text, so a path named like a closing fence is escaped there, not here).
 *
 * The cache is one row per repository (migration 0807), keyed by the commit and the map version. A run at the same commit makes no
 * GitHub call but the cheap head lookup; another commit rebuilds and replaces the row.
 */
export const REPO_MAP_MAX_BYTES = 8192;
export const REPO_MAP_VERSION = "1";
export const REPO_MAP_MAX_DEPTH = 4;
export const REPO_MAP_TRUNCATED_MARKER = "[map truncated]";
const MAX_MANIFESTS = 6;
const MAX_SCRIPTS = 8;
const MAX_PATH_BYTES = 200;

/** The GitHub reads the map needs (structurally the `RepoTreeSource` of @fx/github). */
export interface RepoMapSource {
  headSha(): Promise<string | null>;
  tree(sha: string): Promise<{ truncated: boolean; entries: ReadonlyArray<{ path: string; type: "blob" | "tree" | "commit"; sha: string }> } | null>;
  blob(sha: string): Promise<string | null>;
}

const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");
const CONTROL_RE = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const oneLine = (s: string, max: number): string => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim().slice(0, max);

export interface Manifest {
  path: string;
  name: string | null;
  scripts: Array<[string, string]>;
  hasTest: boolean;
}

/** Name and scripts of one package.json text; null when it does not parse to an object. */
export function readManifest(path: string, text: string): Manifest | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // fx-swallow-ok: a manifest that does not parse is left out of the map
    return null;
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const j = json as { name?: unknown; scripts?: unknown };
  const scripts: Array<[string, string]> = [];
  let hasTest = false;
  if (j.scripts !== null && typeof j.scripts === "object" && !Array.isArray(j.scripts)) {
    for (const [k, v] of Object.entries(j.scripts as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      if (k === "test") hasTest = true;
      if (scripts.length < MAX_SCRIPTS) scripts.push([oneLine(k, 40), oneLine(v, 60)]);
    }
  }
  return { path, name: typeof j.name === "string" ? oneLine(j.name, 80) : null, scripts, hasTest };
}

export interface RepoMapInput {
  sha: string;
  paths: ReadonlyArray<{ path: string; type: "blob" | "tree" | "commit" }>;
  /** GitHub cut the tree it returned. */
  truncated: boolean;
  manifests: readonly Manifest[];
}

/** The test command we can tell from the files: the root package.json's `test` script first, then well-known marker files. */
export function detectTestCommand(files: ReadonlySet<string>, manifests: readonly Manifest[]): string | null {
  if (manifests.find((m) => m.path === "package.json")?.hasTest) return files.has("pnpm-lock.yaml") ? "pnpm test" : files.has("yarn.lock") ? "yarn test" : "npm test";
  if (files.has("Cargo.toml")) return "cargo test";
  if (files.has("go.mod")) return "go test ./...";
  if (files.has("pytest.ini") || files.has("pyproject.toml") || files.has("setup.cfg")) return "pytest";
  return null;
}

/** The map text. Deterministic: the same input gives the same bytes. Never more than REPO_MAP_MAX_BYTES, marker included. */
export function buildRepoMap(input: RepoMapInput): string {
  // A manifest path gets the same filter as a file path: a control character (CR, LF, U+2028/2029, U+0085) or more than MAX_PATH_BYTES drops it,
  // so a path can never start a line of its own in the text.
  const manifests = input.manifests.filter((m) => !CONTROL_RE.test(m.path) && bytesOf(m.path) <= MAX_PATH_BYTES);
  const files = new Set<string>();
  const folded = new Map<string, number>();
  for (const e of input.paths) {
    if (e.type === "tree" || CONTROL_RE.test(e.path) || bytesOf(e.path) > MAX_PATH_BYTES) continue;
    const parts = e.path.split("/");
    if (parts.length <= REPO_MAP_MAX_DEPTH) files.add(e.type === "commit" ? `${e.path}@submodule` : e.path);
    else {
      const dir = `${parts.slice(0, REPO_MAP_MAX_DEPTH).join("/")}/`;
      folded.set(dir, (folded.get(dir) ?? 0) + 1);
    }
  }
  const rootFiles = new Set(input.paths.filter((p) => p.type === "blob" && !p.path.includes("/")).map((p) => p.path));
  const lines: string[] = [`commit: ${input.sha.slice(0, 12)}`, `test command: ${detectTestCommand(rootFiles, manifests) ?? "not detected"}`];
  if (manifests.length > 0) {
    lines.push("package manifests:");
    for (const m of manifests) lines.push(`${m.path}: name=${m.name ?? "(none)"}${m.scripts.length > 0 ? `; scripts: ${m.scripts.map(([k, v]) => `${k}=${v}`).join(", ")}` : ""}`);
  }
  lines.push("files:");
  const body = [...files, ...[...folded].map(([dir, n]) => `${dir} (${n} files)`)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  lines.push(...body);

  // Fits whole (and GitHub sent the whole tree): no marker. Otherwise whole lines up to the cap, then the marker.
  const whole = lines.join("\n");
  if (!input.truncated && bytesOf(whole) <= REPO_MAP_MAX_BYTES) return whole;
  const room = REPO_MAP_MAX_BYTES - bytesOf(`\n${REPO_MAP_TRUNCATED_MARKER}`);
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = used + bytesOf(line) + (kept.length > 0 ? 1 : 0);
    if (next > room) break;
    kept.push(line);
    used = next;
  }
  return [...kept, REPO_MAP_TRUNCATED_MARKER].join("\n");
}

/** Where the built map is kept, one per repository. */
export interface RepoMapCache {
  get(key: { accountId: string; repoId: string; commitSha: string; version: string }): Promise<string | null>;
  put(key: { accountId: string; repoId: string; commitSha: string; version: string }, text: string): Promise<void>;
}

/** The cache in Postgres (migration 0807). A repository with no installation any more gets nothing out of it. */
export function createPgRepoMapCache(pool: Pool): RepoMapCache {
  return {
    async get({ accountId, repoId, commitSha, version }) {
      return withTenant(pool, accountId, async (client) => {
        const { rows } = await client.query<{ body: string }>(
          `SELECT m.body FROM repo_context_maps m
             JOIN repos r ON r.account_id = m.account_id AND r.id = m.repo_id AND r.installation_id IS NOT NULL
            WHERE m.account_id = $1 AND m.repo_id = $2 AND m.commit_sha = $3 AND m.map_version = $4`,
          [accountId, repoId, commitSha, version],
        );
        return rows[0]?.body ?? null;
      });
    },
    async put({ accountId, repoId, commitSha, version }, text) {
      const sha = createHash("sha256").update(text, "utf8").digest("hex");
      await withTenant(pool, accountId, (client) =>
        client.query(
          `INSERT INTO repo_context_maps (account_id, repo_id, commit_sha, map_version, body, body_sha256) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (account_id, repo_id) DO UPDATE SET commit_sha = EXCLUDED.commit_sha, map_version = EXCLUDED.map_version, body = EXCLUDED.body, body_sha256 = EXCLUDED.body_sha256, built_at = now()`,
          [accountId, repoId, commitSha, version, text, sha],
        ),
      );
    },
  };
}

export interface RepoMapRequest {
  accountId: string;
  repoId: string;
  owner: string;
  name: string;
}

/** What the build step asks for. Absent answer: the run starts without a map (a map is never a reason to refuse or delay a run). */
export interface RepoMapPort {
  /** `cold` (D#600 CX-10a): true when the map had to be built (a cache miss), false when the cached one was used. */
  forRun(request: RepoMapRequest): Promise<{ version: string; text: string; cold: boolean } | undefined>;
}

export function createRepoMapPort(deps: { open: (request: RepoMapRequest) => Promise<RepoMapSource>; cache: RepoMapCache; log?: (reason: string) => void }): RepoMapPort {
  const skip = (reason: string): undefined => {
    deps.log?.(reason);
    return undefined;
  };
  return {
    async forRun(request) {
      try {
        const source = await deps.open(request);
        const sha = await source.headSha();
        if (sha === null) return skip("no_head");
        const key = { accountId: request.accountId, repoId: request.repoId, commitSha: sha, version: REPO_MAP_VERSION };
        const cached = await deps.cache.get(key);
        if (cached !== null) return { version: REPO_MAP_VERSION, text: cached, cold: false };
        const tree = await source.tree(sha);
        if (tree === null) return skip("no_tree");
        // Package manifests near the root, shallowest first, a bounded number: each is one more GitHub call.
        const candidates = tree.entries
          .filter((e) => e.type === "blob" && /(^|\/)package\.json$/.test(e.path) && e.path.split("/").length <= 3 && !e.path.split("/").includes("node_modules"))
          .sort((a, b) => a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : 1))
          .slice(0, MAX_MANIFESTS);
        const manifests: Manifest[] = [];
        for (const c of candidates) {
          const text = await source.blob(c.sha);
          const m = text === null ? null : readManifest(c.path, text);
          if (m) manifests.push(m);
        }
        const text = buildRepoMap({ sha, paths: tree.entries, truncated: tree.truncated, manifests });
        await deps.cache.put(key, text).catch(() => skip("cache_write_failed"));
        return { version: REPO_MAP_VERSION, text, cold: true };
      } catch {
        // fx-swallow-ok: a map that cannot be built is left out of the prompt; the run starts without it and the reason is logged as a fixed word
        return skip("unavailable");
      }
    },
  };
}
