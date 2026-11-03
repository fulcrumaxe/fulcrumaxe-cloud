import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D#598 P1g-1 (acceptances 5 and 7), a static scan: no force-style push exists in the product sources or the scripts except the one named below, with the
 * reason it is allowed. The one in the harness is the lease-gated update of an item's own paired branch, whose value is a validated 40-hex head.
 *
 * The scan reads each file as lines. A line that runs git's `push` (`git ... push`, or a quoted "push" argument) opens a WINDOW of that line and the next few,
 * so an argv array or a shell command split over lines is read as one command; the window stops at a blank line. Inside a window it flags a force flag,
 * a mirror or delete flag, a `+` refspec (quoted, unquoted, or built by concatenation) and a delete refspec (`:branch`). Separately it flags any lease, and
 * any ref-update API call (a PATCH of `git/refs`, `updateRef`) whose window mentions `force` or PATCH.
 *
 * What a line scan cannot see: a command assembled from pieces in different statements (a flag held in a variable and spliced in elsewhere), or text read at
 * run time. Those forms are not in the repo today; the harness takes no flag from any caller (the transport's push input has a head and nothing else), and the
 * last test below pins that.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SOURCE = /\.(ts|tsx|mjs|js|sh|py)$/;
const SKIP = new Set(["node_modules", "dist", ".next"]);
const WINDOW = 6;

const COMMENT = /^\s*(\/\/|\*|\/\*|#)/;
/** A line that runs git's push: `git ... push`, or a quoted "push" / 'push' / `push` argument. A method call `.push(` is not one. */
const RUNS_PUSH = /\bgit\b[^\n]*\bpush\b|["'`]push["'`]/;
const PUSH_RULES: ReadonlyArray<{ name: string; rx: RegExp }> = [
  { name: "force flag", rx: /--force(?!-with-lease)\b|--force-if-includes|(^|[\s"'`,[])-f(?=[\s"'`,\]]|$)/ },
  { name: "mirror or delete flag", rx: /--mirror|--delete|(^|[\s"'`,[])-d(?=[\s"'`,\]]|$)/ },
  { name: "+ refspec", rx: /(^|[\s"'`,[])\+[\w./${}*-]+(:|\s|["'`,\]]|$)|["'`]\+["'`]\s*\+|\+\s*["'`]\+["'`]|["'`]\+[\w./${}*-]*:/ },
  { name: "delete refspec", rx: /(^|\s|["'`])\s*:[A-Za-z$][\w./${}-]*(?=["'`\s\],)]|$)|["'`]:\$?\{?[A-Za-z]/ },
];
const API_RULE = /\bupdateRef\b|git\/refs/;
const API_FORCE = /\bPATCH\b|\bforce\b/;
const LEASE = /--force-with-lease/;

interface Hit {
  rule: string;
  line: number;
}

/** Every flagged place in one file's text. Exported to the plants below. */
function scanSource(text: string): Hit[] {
  const lines = text.split("\n");
  const out: Hit[] = [];
  const delta = (l: string): number => (l.match(/[[(]/g) ?? []).length - (l.match(/[\])]/g) ?? []).length;
  /** The statement the push on line `i` belongs to: back to the line that opened a still-open bracket (at most 4 up), then forward until it closes, a blank line, or WINDOW lines. */
  const windowAt = (i: number): string => {
    let from = i;
    // Only an argv element ("push" as a quoted argument) can sit inside a bracket opened on an earlier line; prose that says `git push` stands alone.
    for (let k = 1; k <= 4 && i - k >= 0 && /["'`]push["'`]/.test(lines[i]!); k++) {
      if (lines[i - k]!.trim() === "") break;
      let d = 0;
      let open = true;
      for (let j = i - k; j < i; j++) {
        d += delta(lines[j]!);
        if (d <= 0) open = false;
      }
      if (open) from = i - k;
    }
    const parts: string[] = [];
    let depth = 0;
    for (let j = from; j < Math.min(lines.length, i + WINDOW); j++) {
      const l = lines[j]!;
      if (j > i && l.trim() === "") break;
      parts.push(l);
      depth += delta(l);
      if (j >= i && depth <= 0 && !/\\\s*$/.test(l)) break;
    }
    return parts.join("\n");
  };
  /** Three lines either side, for an API call whose method and path sit on different lines. */
  const around = (i: number): string =>
    lines
      .slice(Math.max(0, i - 3), i + 4)
      .filter((l) => !COMMENT.test(l))
      .join("\n");
  lines.forEach((line, i) => {
    if (COMMENT.test(line)) return;
    if (LEASE.test(line)) out.push({ rule: "lease", line: i + 1 });
    if (RUNS_PUSH.test(line) && !/\.push\(/.test(line.replace(/["'`]push["'`]/g, ""))) {
      const w = windowAt(i)
        .split("\n")
        .filter((l) => !COMMENT.test(l))
        .join("\n");
      for (const r of PUSH_RULES) if (r.rx.test(w)) out.push({ rule: r.name, line: i + 1 });
    }
    if (API_RULE.test(line) && API_FORCE.test(around(i))) out.push({ rule: "ref update call", line: i + 1 });
  });
  return out;
}

/** Every allowed hit: file, rule, and why. A new hit anywhere else fails the test; a listed one that no longer exists fails it too. */
const ALLOWED: ReadonlyArray<{ file: string; rule: string; why: string }> = [
  { file: "packages/runner-protocol/src/planePush/planePushTransport.ts", rule: "lease", why: "the harness's only force-style push: --force-with-lease=<ref>:<head> with a head validated as 40-hex, for the item's own paired branch" },
];

function walk(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // fx-swallow-ok: a package without a src directory has nothing to scan
    return;
  }
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(name)) out.push(full);
  }
}

/**
 * Files that exist only in the private tree are not part of the public product. The private tree lists them in its own overlay list; this reads whatever
 * list file is beside this repo's CI scripts, and in the public tree there is none, so nothing is skipped there.
 */
function privateOnly(): (path: string) => boolean {
  const dir = join(ROOT, "scripts/ci");
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("publish-denylist.") || !name.endsWith(".local")) continue;
    for (const raw of readFileSync(join(dir, name), "utf8").split("\n")) {
      const entry = raw.split("\t")[0]!.trim();
      if (entry !== "" && !entry.startsWith("#")) entries.push(entry);
    }
  }
  return (path) => entries.some((e) => (e.endsWith("/") ? path.startsWith(e) : path === e));
}

function repoHits(): Array<Hit & { file: string }> {
  const skip = privateOnly();
  const files: string[] = [];
  for (const pkg of readdirSync(join(ROOT, "packages"))) walk(join(ROOT, "packages", pkg, "src"), files);
  walk(join(ROOT, "scripts"), files);
  const out: Array<Hit & { file: string }> = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    if (skip(rel)) continue;
    for (const h of scanSource(readFileSync(f, "utf8"))) out.push({ ...h, file: rel });
  }
  return out;
}

describe("D#598 P1g-1: no force-style push outside the reviewed list (static scan)", () => {
  it("finds exactly the reviewed hits, each with a stated reason", () => {
    const found = repoHits();
    const key = (h: { file: string; rule: string }): string => `${h.file}|${h.rule}`;
    const allowed = new Set(ALLOWED.map(key));
    expect(found.filter((h) => !allowed.has(key(h))).map((h) => `${h.file}:${h.line} ${h.rule}`)).toEqual([]);
    expect([...allowed].filter((a) => !found.some((h) => key(h) === a))).toEqual([]);
    for (const a of ALLOWED) expect(a.why.length, a.file).toBeGreaterThan(20);
  });

  it("the harness has one lease, it is built from the validated head alone, and the head is checked as 40-hex before it is used", () => {
    const src = readFileSync(join(ROOT, "packages/runner-protocol/src/planePush/planePushTransport.ts"), "utf8");
    const code = src.split("\n").filter((l) => !COMMENT.test(l)).join("\n");
    const leases = code.match(/--force-with-lease=[^\n]*/g) ?? [];
    expect(leases).toHaveLength(1);
    expect(leases[0]).toContain("--force-with-lease=refs/heads/${branch}:${expectedHead}`");
    expect(src).toContain("if (expectedHead !== undefined && !OBJECT_ID.test(expectedHead))");
    // No caller can choose a flag: the transport's push input has a head and nothing named force or lease.
    expect(src).toMatch(/push\(input: \{ repoDir: string; codeRepo: string; commit: string; branch: string; token: string; expectedHead\?: string \}\)/);
  });

  describe("the scan can fail: each form below is flagged", () => {
    const PLANTS: Array<[string, string, string]> = [
      ["force flag in argv", 'await git(dir, ["push", "--force", url, ref]);', "force flag"],
      ["short force flag in shell", "git push -f origin main", "force flag"],
      ["force flag on a later line of a multi-line argv", 'await git(dir, [\n  "push",\n  "--quiet",\n  url,\n  "--force",\n  ref,\n]);', "force flag"],
      ["force flag on a later line of a shell command", "git push origin main \\\n  --force", "force flag"],
      ["mirror", "git push --mirror origin", "mirror or delete flag"],
      ["delete flag", "git push origin --delete topic", "mirror or delete flag"],
      ["unquoted + refspec", "git push origin +main:main", "+ refspec"],
      ["unquoted +HEAD", "git push origin +HEAD", "+ refspec"],
      ["quoted + refspec", 'await git(dir, ["push", url, "+HEAD:refs/heads/x"]);', "+ refspec"],
      ["+ built by concatenation", 'await git(dir, ["push", url, "+" + ref + ":" + ref]);', "+ refspec"],
      ["template + refspec", "await git(dir, [`push`, url, `+${local}:refs/heads/${branch}`]);", "+ refspec"],
      ["delete refspec in shell", "git push origin :topic", "delete refspec"],
      ["delete refspec in argv", 'await git(dir, ["push", url, ":topic"]);', "delete refspec"],
      ["delete refspec in a template", "await git(dir, ['push', url, `:${branch}`]);", "delete refspec"],
      ["ref PATCH", 'await http.request({ method: "PATCH", path: `${base}/git/refs/heads/x` });', "ref update call"],
      ["ref PATCH split over lines", 'await http.request({\n  method: "PATCH",\n  path: `${base}/git/refs/heads/x`,\n});', "ref update call"],
      ["ref update with force over lines", "await octokit.git.updateRef({\n  ref,\n  sha,\n  force: true,\n});", "ref update call"],
      ["a lease anywhere", 'await git(dir, ["push", "--force-with-lease=a:b", url]);', "lease"],
    ];
    for (const [name, text, rule] of PLANTS) {
      it(name, () => {
        expect(scanSource(text).map((h) => h.rule)).toContain(rule);
      });
    }
    it("and it stays quiet on the ordinary forms: an array push, a plain push, a fetch with a + refspec, a branch-name colon", () => {
      for (const text of [
        "list.push(item);",
        "out.push({ kind: 'a', path: p });",
        'await git(dir, ["push", "--quiet", "--no-verify", url, `${local}:refs/heads/${branch}`]);',
        "git push origin main",
        'await git(dir, ["fetch", "--quiet", url, "+refs/heads/main:refs/x"]);',
        "const x = { push: true, name: 'a' };",
      ]) {
        expect(scanSource(text), text).toEqual([]);
      }
    });
  });
});
