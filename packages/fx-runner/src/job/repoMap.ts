import { sha256Text } from "@fulcrumaxe/runner-protocol";

/**
 * D#600 CX-3b: the repository map on the runner's side. The text is a pure function of a commit's file tree, and it is the same text the
 * cloud builds for a hosted run (CX-3a, the pipeline package's prompt/repoMap.ts) from GitHub's trees API: the same constants, the same
 * line layout, the same order, the same cap. That is the contract, and the shared fixture `repoMapShared.json` in this package's tests pins it: the cloud's tests and
 * this package's tests both build the map of that one tree and must reach the one sha256 recorded in it. A change to either builder that
 * moves a byte fails the other side's test.
 *
 * Why it is copied and not imported: this package imports only itself, node built-ins and the protocol package (publicBoundary test),
 * and the cloud's pipeline package is neither. What crosses to the cloud is the map's byte count and its sha256 (the ledger's `map`
 * section), never a path or any text of it (C8 section 6).
 *
 * Deterministic and with no model call. It holds the file paths down to a depth cap (deeper files fold into their folder with a count),
 * each package manifest's name and scripts, and the detected test command, and it is cut to REPO_MAP_MAX_BYTES with a marker.
 */
export const REPO_MAP_MAX_BYTES = 8192;
export const REPO_MAP_VERSION = "1";
export const REPO_MAP_MAX_DEPTH = 4;
export const REPO_MAP_TRUNCATED_MARKER = "[map truncated]";
/** The largest manifest read, as on the cloud side (a bigger blob is "no manifest here"). */
export const REPO_MAP_BLOB_MAX_BYTES = 65_536;
const MAX_MANIFESTS = 6;
const MAX_SCRIPTS = 8;
const MAX_PATH_BYTES = 200;

const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");
const CONTROL_RE = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const oneLine = (s: string, max: number): string => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim().slice(0, max);

/** One entry of a recursive tree listing. `commit` is a submodule. */
export interface RepoMapEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

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

/** The package manifests worth reading: near the root, shallowest first, a bounded number (each is one more read). */
export function manifestCandidates(entries: readonly RepoMapEntry[]): RepoMapEntry[] {
  return entries
    .filter((e) => e.type === "blob" && /(^|\/)package\.json$/.test(e.path) && e.path.split("/").length <= 3 && !e.path.split("/").includes("node_modules"))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : 1))
    .slice(0, MAX_MANIFESTS);
}

export interface RepoMapInput {
  /** The commit the map is of. */
  sha: string;
  paths: ReadonlyArray<{ path: string; type: "blob" | "tree" | "commit" }>;
  /** The listing was cut (the tree was too large to list whole). */
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

  // Fits whole (and the listing was whole): no marker. Otherwise whole lines up to the cap, then the marker.
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

/** What the ledger records about a map: its UTF-8 byte count and the hex sha256 of its text. Nothing of the text itself. */
export function repoMapDigest(text: string): { bytes: number; sha256: string } {
  return { bytes: bytesOf(text), sha256: sha256Text(text) };
}

/** The map as the prompt carries it: a header line, then the text. The header names the version, as on the cloud side. */
export function repoMapHeading(version: string): string {
  return `REPOSITORY MAP (version ${version}):`;
}
