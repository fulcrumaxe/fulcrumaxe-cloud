#!/usr/bin/env node
// Decides how much of the suite a pull request has to run.
//
//   node scripts/ci/affected.mjs --base <sha> --head <sha> [--force-full <value>] [--labels <a,b> | --labels-api]
//
// `ci:full` is read from the pull request's CURRENT labels. In CI that is `--labels-api`: the script asks the
// GitHub API (GITHUB_REPOSITORY, CI_PR_NUMBER, a read-only GH_TOKEN) at the moment it runs, because a re-run
// of a workflow run replays the ORIGINAL event payload and that payload's label list is stale by then. If the
// read fails for any reason the answer is `full`. `--labels` is for running the script by hand and is ignored
// when `--labels-api` is given.
//
// Prints one JSON object:
//   {"mode":"full"|"affected","reason":"...","trigger":"<glob>"|null,"packages":["apps/web",...],"e2e":true|false,"lint":["scripts/ci"]|[]}
//
//   full      run everything, exactly as a push to main does. `trigger` names the glob that forced it
//             (or null when the cause is something else, which `reason` then states).
//   affected  run only `packages` (workspace package directories): the packages the change touches plus
//             every package that depends on one of them, directly or through others.
//
// A full run no longer implies e2e. `e2e` is true only when a changed file matches `e2e_paths`, or the change
// touches the e2e job of ci.yml (see ciWorkflowEffect); a run that fails closed still says true.
//
// Three content rules read WHAT changed, not only which file (each falls back to the path rule on any doubt):
// a package.json whose parsed JSON differs only in non-build metadata keys; a ci.yml diff confined to the
// node-test step's run line (no trigger at all) or to the check job (a trigger, but not an e2e one); and the
// `standalone` files, which need only their own run.
//
// Fails closed: whenever it cannot be sure, the answer is `full` and `reason` names the cause. The list of
// what forces a full run lives in scripts/ci/full-run-triggers.json and nowhere else.
//
// The change is `git diff base head`, i.e. the committed range only. A working-tree edit is never seen, and
// when the caller passes the pull-request merge commit as head and its first parent as base, a main merge
// that the branch already contains is not part of the range (D#497: a diff over the wrong range answers
// wrongly and silently). The workspace graph is read from the head commit for the same reason.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(HERE, "../..");
const DEFAULT_TRIGGER_FILE = path.join(HERE, "full-run-triggers.json");
const EDGE_KEYS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** Thrown for any condition that must turn into a full run. */
class FailClosed extends Error {}

/** Glob to RegExp. Anchored at the repository root: `**` crosses `/`, `*` and `?` do not. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** How specific a glob is: the number of literal characters. Used to pick which of several matches to report. */
function specificity(glob) {
  return glob.replace(/[*?]/g, "").length;
}

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** The text of each `rev:path` object (null when absent), through one `git cat-file --batch` process. */
function readBlobs(repoRoot, specs) {
  const res = spawnSync("git", ["-C", repoRoot, "cat-file", "--batch"], { input: `${specs.join("\n")}\n`, maxBuffer: 256 * 1024 * 1024 });
  if (res.error || res.status !== 0) throw new FailClosed(`dependency graph unreadable: git cat-file failed`);
  const buf = res.stdout;
  const out = [];
  let at = 0;
  for (let i = 0; i < specs.length; i++) {
    const nl = buf.indexOf(0x0a, at);
    if (nl === -1) throw new FailClosed("dependency graph unreadable: truncated git cat-file output");
    const header = buf.toString("utf8", at, nl);
    at = nl + 1;
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
      out.push(null);
      continue;
    }
    const m = header.match(/^\S+ (\S+) (\d+)$/);
    if (!m || m[1] !== "blob") {
      out.push(null);
      continue;
    }
    const size = Number(m[2]);
    out.push(buf.toString("utf8", at, at + size));
    at += size + 1;
  }
  return out;
}

function mustBeStringList(value, what) {
  if (!Array.isArray(value) || value.some((e) => !e || typeof e.glob !== "string" || typeof e.reason !== "string")) {
    throw new FailClosed(`trigger file: ${what} must be a list of {glob, reason}`);
  }
}

/** Reads and validates the trigger file. */
export function loadTriggers(file = DEFAULT_TRIGGER_FILE) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new FailClosed(`trigger file unreadable (${file}): ${err.message}`);
  }
  if (!doc || !Number.isInteger(doc.version)) throw new FailClosed("trigger file: missing integer version");
  mustBeStringList(doc.triggers, "triggers");
  mustBeStringList(doc.ignore, "ignore");
  mustBeStringList(doc.e2e_paths, "e2e_paths");
  if (!Array.isArray(doc.extra_edges) || doc.extra_edges.some((e) => !e || typeof e.from !== "string" || typeof e.to !== "string")) {
    throw new FailClosed("trigger file: extra_edges must be a list of {from, to, kind, reason}");
  }
  mustBeStringList(doc.standalone, "standalone");
  if (!Array.isArray(doc.metadata_only_keys) || doc.metadata_only_keys.length === 0 || doc.metadata_only_keys.some((k) => typeof k !== "string")) {
    throw new FailClosed("trigger file: metadata_only_keys must be a non-empty list of strings");
  }
  const cw = doc.ci_workflow;
  if (!cw || ["file", "test_step", "unit_job", "reason"].some((k) => typeof cw[k] !== "string" || cw[k] === "")) {
    throw new FailClosed("trigger file: ci_workflow must be {file, test_step, unit_job, reason}");
  }
  if (!Array.isArray(doc.active_edge_kinds) || doc.active_edge_kinds.some((k) => typeof k !== "string")) {
    throw new FailClosed("trigger file: active_edge_kinds must be a list of strings");
  }
  return doc;
}

/** Package directories matched by the `packages:` globs of pnpm-workspace.yaml (one `*` segment at the end). */
function workspaceGlobs(yamlText) {
  const globs = [];
  let inPackages = false;
  for (const raw of yamlText.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s+-\s+["']?([^"']+?)["']?\s*$/);
      if (m) globs.push(m[1]);
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  if (globs.length === 0) throw new FailClosed("dependency graph unreadable: no packages: globs in pnpm-workspace.yaml");
  return globs;
}

/**
 * The workspace graph at `head`: { packages: Map<dir, name>, deps: Map<dir, Set<dir>> } where deps maps a
 * package to the packages it depends on. Edges: any dependency whose name is a workspace package, in any of
 * the four dependency fields, whatever its version specifier, plus the extra edges from the trigger file.
 */
export function readGraph(repoRoot, head, extraEdges = []) {
  let globs;
  let files;
  try {
    globs = workspaceGlobs(git(repoRoot, ["show", `${head}:pnpm-workspace.yaml`]));
    files = git(repoRoot, ["ls-tree", "-r", "--name-only", head]).split("\n");
  } catch (err) {
    if (err instanceof FailClosed) throw err;
    throw new FailClosed(`dependency graph unreadable: ${String(err.message).split("\n")[0]}`);
  }
  const matchers = globs.map((g) => globToRegExp(`${g}/package.json`));
  const dirs = files.filter((f) => matchers.some((re) => re.test(f))).map((f) => f.slice(0, -"/package.json".length));
  if (dirs.length === 0) throw new FailClosed("dependency graph unreadable: no workspace packages found");
  const names = new Map();
  const manifests = new Map();
  const texts = readBlobs(repoRoot, dirs.map((d) => `${head}:${d}/package.json`));
  for (const [i, dir] of dirs.entries()) {
    let pkg;
    try {
      if (texts[i] === null) throw new Error("missing at the head commit");
      pkg = JSON.parse(texts[i]);
    } catch (err) {
      throw new FailClosed(`dependency graph unreadable: ${dir}/package.json (${String(err.message).split("\n")[0]})`);
    }
    if (!pkg || typeof pkg.name !== "string") throw new FailClosed(`dependency graph unreadable: ${dir}/package.json has no name`);
    names.set(pkg.name, dir);
    manifests.set(dir, pkg);
  }
  const deps = new Map(dirs.map((d) => [d, new Set()]));
  for (const [dir, pkg] of manifests) {
    for (const key of EDGE_KEYS) {
      for (const dep of Object.keys(pkg[key] ?? {})) {
        const target = names.get(dep);
        if (target && target !== dir) deps.get(dir).add(target);
      }
    }
  }
  for (const edge of extraEdges) {
    if (!deps.has(edge.from) || !deps.has(edge.to)) {
      throw new FailClosed(`trigger file: extra edge ${edge.from} -> ${edge.to} names a directory that is not a workspace package`);
    }
    if (edge.from !== edge.to) deps.get(edge.from).add(edge.to);
  }
  return { packages: new Map(dirs.map((d) => [d, manifests.get(d).name])), deps };
}

/** `changed` plus every package that depends on one of them, directly or transitively. Sorted. */
export function withDependents(graph, changed) {
  const dependents = new Map([...graph.packages.keys()].map((d) => [d, new Set()]));
  for (const [dir, targets] of graph.deps) for (const t of targets) dependents.get(t).add(dir);
  const seen = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    for (const next of dependents.get(queue.pop()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen].sort();
}

function full(reason, trigger = null, e2e = true) {
  // One line only: the reason goes into a log line, a summary and the GITHUB_ENV file, and a file name can
  // contain a newline.
  return { mode: "full", reason: String(reason).replace(/[\r\n]+/g, " "), trigger, packages: [], e2e, lint: [] };
}

/**
 * The package.json files among `changed` whose base and head differ only in `metadataKeys`. The comparison is
 * of the parsed JSON with those keys removed (the order of what remains is kept: `exports` conditions are
 * order-sensitive), never of text. A file that is added, deleted, unreadable or unparseable on either side is
 * not in the result, so it keeps the path rule.
 */
export function metadataOnlyManifests(repoRoot, base, head, changed, metadataKeys) {
  const files = changed.filter((f) => (f === "package.json" || f.endsWith("/package.json")) && !/[\r\n]/.test(f));
  if (files.length === 0) return new Set();
  let texts;
  try {
    texts = readBlobs(repoRoot, files.flatMap((f) => [`${base}:${f}`, `${head}:${f}`]));
  } catch {
    return new Set();
  }
  const strip = (text) => {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not an object");
    for (const k of metadataKeys) delete doc[k];
    return JSON.stringify(doc);
  };
  const out = new Set();
  for (const [i, f] of files.entries()) {
    const before = texts[2 * i];
    const after = texts[2 * i + 1];
    if (before === null || after === null) continue;
    try {
      if (strip(before) === strip(after)) out.add(f);
    } catch {
      // unparseable: keep the path rule
    }
  }
  return out;
}

/** Lines of `text` from the first line matching `startRe` up to (not including) the next one matching `endRe`. */
function cutBlock(text, startRe, endRe) {
  const lines = text.split("\n");
  const from = lines.findIndex((l) => startRe.test(l));
  if (from === -1) return null;
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i++) {
    if (endRe.test(lines[i])) {
      to = i;
      break;
    }
  }
  return { block: lines.slice(from, to), rest: [...lines.slice(0, from), "<<cut>>", ...lines.slice(to)].join("\n") };
}

const escapeRe = (t) => t.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/**
 * What a change to ci.yml means, from its content at base and head: { exempt, e2e }.
 *   exempt  the only difference is the `run:` line of the node-test step, and both sides are a plain
 *           `nix develop .#ci --command node --test <files>`: neither a full-run trigger nor an e2e one.
 *   e2e     the difference reaches outside the `check` job (triggers, env, the e2e job, the comments above
 *           `jobs:`). The e2e job is a separate job with its own checkout, so a change inside the check job
 *           cannot alter it. Anything unreadable answers { exempt: false, e2e: true }.
 */
export function ciWorkflowEffect(repoRoot, base, head, cw) {
  const unsure = { exempt: false, e2e: true };
  let before;
  let after;
  try {
    [before, after] = readBlobs(repoRoot, [`${base}:${cw.file}`, `${head}:${cw.file}`]);
  } catch {
    return unsure;
  }
  if (before === null || after === null) return unsure;
  const step = new RegExp(`^ {6}- name: ${escapeRe(cw.test_step)}\\s*$`);
  const stepEnd = /^( {6}(- |#)| {0,4}\S)/;
  const sb = cutBlock(before, step, stepEnd);
  const sa = cutBlock(after, step, stepEnd);
  // Additions only: a test file named at the base must still be named at the head. Dropping one stops a
  // test from running, which changes what CI checks; it is not a bookkeeping edit.
  const filesOf = (line) => new Set(line.trim().split(/\s+/).filter((w) => w.endsWith(".test.mjs")));
  const keepsEveryTest = (b, h) => {
    const kept = filesOf(h);
    return [...filesOf(b)].every((f) => kept.has(f));
  };
  const runLine = /^ {8}run: nix develop .#ci --command node --test( [A-Za-z0-9_./-]+\.test\.mjs)+\s*$/;
  const exempt =
    sb !== null &&
    sa !== null &&
    sb.rest === sa.rest &&
    sb.block.length === sa.block.length &&
    sb.block.every((l, i) => l === sa.block[i] || (runLine.test(l) && runLine.test(sa.block[i]) && keepsEveryTest(l, sa.block[i])));
  const job = new RegExp(`^ {2}${escapeRe(cw.unit_job)}:\\s*$`);
  const jobEnd = /^( {2}[A-Za-z0-9_-]+:\s*$|\S)/;
  const jb = cutBlock(before, job, jobEnd);
  const ja = cutBlock(after, job, jobEnd);
  const e2e = !(jb !== null && ja !== null && jb.rest === ja.rest);
  return { exempt, e2e: exempt ? false : e2e };
}

/**
 * Classifies a change. `input`: { repoRoot, base, head, forceFull, labels, triggerFile }.
 * Never throws; any failure is a full run with the cause in `reason`.
 */
export function classify(input) {
  const { repoRoot = DEFAULT_REPO_ROOT, base, head, forceFull = "", labels = [], labelsError = null, triggerFile = DEFAULT_TRIGGER_FILE } = input;
  try {
    if (forceFull === "true") return full("CI_FORCE_FULL");
    // The labels could not be read, so `ci:full` cannot be ruled out: widen.
    if (labelsError) return full(`could not read the pull request labels (${labelsError})`);
    if (labels.includes("ci:full")) return full("label ci:full");
    const rules = loadTriggers(triggerFile);
    for (const [what, sha] of [["base", base], ["head", head]]) {
      if (!sha) throw new FailClosed(`${what} SHA not given`);
      try {
        git(repoRoot, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
      } catch {
        throw new FailClosed(`${what} SHA cannot be resolved: ${sha}`);
      }
    }
    let changed;
    try {
      changed = git(repoRoot, ["diff", "--name-only", "-z", "--no-renames", base, head]).split("\0").filter(Boolean).sort();
    } catch (err) {
      throw new FailClosed(`git diff failed: ${String(err.message).split("\n")[0]}`);
    }

    // Content rules: what a changed file actually changed (D#507 follow-up).
    const metaOnly = metadataOnlyManifests(repoRoot, base, head, changed, rules.metadata_only_keys);
    const cw = rules.ci_workflow;
    const ci = changed.includes(cw.file) ? ciWorkflowEffect(repoRoot, base, head, cw) : null;
    const standalone = rules.standalone.map((i) => globToRegExp(i.glob));
    const relevant = changed.filter((f) => !metaOnly.has(f) && !(f === cw.file && ci.exempt));
    // A full run forces the unit and check scope; the e2e jobs have their own answer. A workflow file other
    // than ci.yml cannot change the e2e job.
    const e2eRes = rules.e2e_paths.map((p) => globToRegExp(p.glob));
    const e2e = relevant.some((f) =>
      f === cw.file ? ci.e2e : f.startsWith(".github/workflows/") ? false : e2eRes.some((re) => re.test(f)),
    );

    const triggers = rules.triggers.map((t) => ({ ...t, re: globToRegExp(t.glob), rank: specificity(t.glob) }));
    for (const file of relevant) {
      if (standalone.some((re) => re.test(file))) continue;
      const hits = triggers.filter((t) => t.re.test(file)).sort((a, b) => b.rank - a.rank);
      if (hits.length > 0) return full(`${file} matches a full-run trigger: ${hits[0].reason}`, hits[0].glob, e2e);
    }

    const graph = readGraph(
      repoRoot,
      head,
      rules.extra_edges.filter((e) => rules.active_edge_kinds.includes(e.kind)),
    );
    const dirs = [...graph.packages.keys()].sort((a, b) => b.length - a.length);
    const ignore = rules.ignore.map((i) => globToRegExp(i.glob));
    const touched = new Set();
    for (const file of relevant) {
      if (standalone.some((re) => re.test(file))) continue;
      const owner = dirs.find((d) => file.startsWith(`${d}/`));
      if (owner) touched.add(owner);
      else if (!ignore.some((re) => re.test(file))) {
        throw new FailClosed(`${file} belongs to no workspace package, matches no trigger and is not on the ignore list`);
      }
    }
    // A metadata-only edit to a workspace package's manifest still selects THAT package (a test may assert
    // the field: publicBoundary.test.ts reads manifest.license), but not its dependents.
    const own = [...metaOnly].map((f) => f.slice(0, -"/package.json".length)).filter((d) => graph.packages.has(d));
    const packages = [...new Set([...withDependents(graph, touched), ...own])].sort();
    // check.sh lints only the affected packages in an affected run, and a standalone CI test is in none.
    const lint = relevant.some((f) => standalone.some((re) => re.test(f))) ? ["scripts/ci"] : [];
    const reason =
      changed.length === 0
        ? "no changed files"
        : packages.length === 0
          ? relevant.length === 0
            ? "only metadata-only manifest edits and exempt CI edits"
            : relevant.some((f) => standalone.some((re) => re.test(f)))
              ? "only ignored and standalone test paths changed"
              : "only ignored paths changed"
          : touched.size === 0
            ? `${own.length} package${own.length === 1 ? "" : "s"} with a metadata-only manifest edit (selected alone, no dependents)`
            : `${touched.size} changed package${touched.size === 1 ? "" : "s"} plus dependents`;
    return { mode: "affected", reason, trigger: null, packages, e2e, lint };
  } catch (err) {
    if (err instanceof FailClosed) return full(err.message);
    return full(`classifier error: ${String(err && err.message).split("\n")[0]}`);
  }
}

/** The one line a pull-request run shows for a result. */
export function scopeLine(result) {
  if (result.mode === "full") return `CI scope: full (${result.trigger ?? result.reason})`;
  if (result.packages.length === 0) return "CI scope: affected — 0 packages (ignored paths only)";
  return `CI scope: affected — ${result.packages.length} packages: ${result.packages.join(", ")}`;
}

/** The e2e job's log line when the specs are not needed. */
export function e2eSkipLine(result) {
  const why = result.mode === "full" ? `full unit scope: ${result.trigger ?? result.reason}` : result.reason;
  return `skipped: not affected (${why}; no e2e-relevant path changed)`;
}

const LABEL_PAGE_SIZE = 100;
const LABEL_MAX_PAGES = 10;

/**
 * The pull request's labels as they are right now, from the GitHub API (read-only, one GET per page).
 * Resolves { labels } or { error } and never rejects. Needs GITHUB_REPOSITORY, CI_PR_NUMBER and GH_TOKEN
 * in `env`; GITHUB_API_URL overrides the API root (GitHub sets it on every runner; tests point it at a local server).
 */
export async function fetchPrLabels(env = process.env, fetchImpl = globalThis.fetch) {
  try {
    const repo = env.GITHUB_REPOSITORY ?? "";
    const number = env.CI_PR_NUMBER ?? "";
    const token = env.GH_TOKEN ?? "";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { error: "GITHUB_REPOSITORY is missing or malformed" };
    if (!/^[1-9][0-9]{0,9}$/.test(number)) return { error: "CI_PR_NUMBER is missing or malformed" };
    if (!token) return { error: "GH_TOKEN is missing" };
    const root = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
    const labels = [];
    for (let page = 1; page <= LABEL_MAX_PAGES; page++) {
      const res = await fetchImpl(`${root}/repos/${repo}/issues/${number}/labels?per_page=${LABEL_PAGE_SIZE}&page=${page}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "fulcrumaxe-ci-scope",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { error: `GitHub API answered ${res.status}` };
      const body = await res.json();
      if (!Array.isArray(body) || body.some((l) => !l || typeof l.name !== "string")) return { error: "unexpected labels response" };
      labels.push(...body.map((l) => l.name));
      if (body.length < LABEL_PAGE_SIZE) return { labels };
    }
    return { error: `more than ${LABEL_PAGE_SIZE * LABEL_MAX_PAGES} labels` };
  } catch (err) {
    return { error: String(err && err.message).split("\n")[0] || "request failed" };
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === "github" || key === "e2e-step" || key === "labels-api") {
      out[key] = true;
      continue;
    }
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    out[key] = argv[++i];
  }
  return out;
}

/** Appends NAME=value lines to the file a GitHub step exposes as $GITHUB_ENV. */
function exportEnv(file, vars) {
  const lines = Object.entries(vars).map(([k, v]) => {
    if (/[\r\n]/.test(v)) throw new Error(`refusing a multi-line value for ${k}`);
    return `${k}=${v}`;
  });
  appendFileSync(file, `${lines.join("\n")}\n`);
}

async function main() {
  let args;
  let result;
  try {
    args = parseArgs(process.argv.slice(2));
    let labels = (args.labels ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    let labelsError = null;
    if (args["labels-api"]) {
      // The API is the only source: a --labels value is never mixed in. With CI_FORCE_FULL on, the answer is
      // already full, so the request is not made.
      labels = [];
      if (args["force-full"] !== "true") {
        const got = await fetchPrLabels();
        labels = got.labels ?? [];
        labelsError = got.error ?? null;
      }
    }
    result = classify({
      repoRoot: args.repo ?? DEFAULT_REPO_ROOT,
      base: args.base,
      head: args.head,
      forceFull: args["force-full"] ?? "",
      labels,
      labelsError,
      triggerFile: args.triggers ?? DEFAULT_TRIGGER_FILE,
    });
  } catch (err) {
    // Even a bad command line must not turn into a quiet "affected": say full and why.
    args = args ?? { github: process.argv.includes("--github") };
    result = full(`classifier error: ${String(err && err.message).split("\n")[0]}`);
  }
  console.log(JSON.stringify(result));
  if (args.github) {
    const line = scopeLine(result);
    console.error(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
    if (process.env.GITHUB_ENV) {
      exportEnv(process.env.GITHUB_ENV, {
        CI_SCOPE_MODE: result.mode,
        // check.sh runs the full suite unless this is set (comma-separated directories; `none` = no package).
        ...(result.mode === "affected" ? { FX_CHECK_AFFECTED: result.packages.length > 0 ? result.packages.join(",") : "none" } : {}),
        // Extra paths check.sh lints in an affected run (a standalone CI test is in no package).
        ...(result.mode === "affected" && result.lint.length > 0 ? { FX_CHECK_LINT_PATHS: result.lint.join(",") } : {}),
        // The Node 22 step covers both packages that install on customers' machines.
        CI_SCOPE_RUNNER_PROTOCOL: String(
          result.mode === "full" || result.packages.includes("packages/runner-protocol") || result.packages.includes("packages/fx-runner"),
        ),
        CI_SCOPE_E2E: String(result.e2e),
      });
    }
    if (args["e2e-step"] && !result.e2e) console.error(e2eSkipLine(result));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
