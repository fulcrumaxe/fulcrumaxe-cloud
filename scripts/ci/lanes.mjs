#!/usr/bin/env node
// Path lanes for merge-queue admission.
//
//   node scripts/ci/lanes.mjs <file>...          one line per file: <lane><TAB><file>
//   printf '%s\n' a b | node scripts/ci/lanes.mjs --stdin
//
// A lane says which queue entries may be admitted together; it is NEVER an input to CI scope (scripts/ci/affected.mjs
// computes that from the real diff). Every file gets exactly one lane. The map is scripts/ci/lanes.json; `hot` is
// built from the `triggers` of scripts/ci/full-run-triggers.json plus the map's `hot_extra`, and anything the map
// does not match is `hot` too, so a wrong or damaged map can only make admission stricter. If the map cannot be
// read at all, every file is `hot`. A classification always exits 0 (an unreadable map answers `hot`, not an
// error); exit 2 is a usage error.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp } from "./affected.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MAP = path.join(HERE, "lanes.json");
export const DEFAULT_TRIGGERS = path.join(HERE, "full-run-triggers.json");
export const HOT = "hot";

const globs = (list) => (Array.isArray(list) ? list : []).filter((g) => typeof g === "string").map(globToRegExp);

/** Build a classifier. Any problem reading either file gives one that answers `hot` for everything. */
export function loadLanes(mapFile = DEFAULT_MAP, triggerFile = DEFAULT_TRIGGERS) {
  try {
    const map = JSON.parse(readFileSync(mapFile, "utf8"));
    const trig = JSON.parse(readFileSync(triggerFile, "utf8"));
    if (!Array.isArray(trig.triggers) || trig.triggers.length === 0) throw new Error("no triggers");
    const hot = [...trig.triggers.map((t) => t.glob), ...(Array.isArray(map.hot_extra) ? map.hot_extra : []).map((t) => t && t.glob)];
    if (hot.some((g) => typeof g !== "string")) throw new Error("bad hot glob");
    const lanes = (Array.isArray(map.lanes) ? map.lanes : [])
      .filter((l) => l && typeof l.name === "string" && l.name !== HOT && Array.isArray(l.globs))
      .map((l) => ({ name: l.name, res: globs(l.globs), ex: globs(l.exclude) }));
    const perDir = (Array.isArray(map.per_dir) ? map.per_dir : [])
      .filter((d) => d && typeof d.prefix === "string" && d.prefix.endsWith("/") && typeof d.lane_prefix === "string");
    return { hot: globs(hot), lanes, perDir };
  } catch {
    return { broken: true, hot: [], lanes: [], perDir: [] };
  }
}

const inLane = (l, file) => l.res.some((re) => re.test(file)) && !l.ex.some((re) => re.test(file));

/** Every lane whose rule matches the path, hot first. `all` is empty when nothing matched (the lane is then hot). */
export function explain(cls, file) {
  if (cls.broken || typeof file !== "string" || file === "") return { lane: HOT, all: [] };
  const all = [];
  if (cls.hot.some((re) => re.test(file))) all.push(HOT);
  const named = cls.lanes.filter((l) => inLane(l, file));
  for (const l of named) all.push(l.name);
  if (named.length === 0) {
    for (const d of cls.perDir) {
      if (!file.startsWith(d.prefix)) continue;
      const rest = file.slice(d.prefix.length);
      const slash = rest.indexOf("/");
      // a file directly under packages/ or apps/ belongs to no package, so it gets no package lane
      if (slash > 0) all.push(d.lane_prefix + rest.slice(0, slash));
    }
  }
  return { lane: all.length === 0 ? HOT : all[0], all };
}

export function classify(cls, file) {
  return explain(cls, file).lane;
}

function main(argv) {
  let files = argv.slice(2);
  if (files[0] === "--stdin") {
    files = readFileSync(0, "utf8").split("\n").filter((l) => l !== "");
  } else if (files.some((f) => f.startsWith("--"))) {
    process.stderr.write("usage: lanes.mjs <file>... | --stdin\n");
    return 2;
  }
  const cls = loadLanes();
  process.stdout.write(files.map((f) => `${classify(cls, f)}\t${f}\n`).join(""));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv);
