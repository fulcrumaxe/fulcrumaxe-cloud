import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const SCAN_GLOB_DIRS = [
  "packages/*/src",
  "packages/db/migrations",
  "apps/*/app",
  "apps/*/src",
  "apps/*/lib",
];

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".sql"]);
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", ".next", "test", "tests"]);

const ENV_NAMES = ["FX_GH_FORWARD_SUFFIX", "FX_GH_FORWARD_HOST"];
/** The one production file allowed to mention the two env names above. */
const ALLOWED_ENV_NAME_FILE = path.join("packages", "runner", "src", "githubForwardConfig.ts");
/** `githubForwardConfig.ts`'s own DEFINITION of `loadGithubForwardConfig`
 * is not a call -- this file is where the function lives, so it is
 * excluded from the "called in no production file" check (c). D#2 H13b
 * (C13/C26) widens this into an allowlist of the proxy's own route and
 * handler files: `loadGithubForwardConfig(process.env)` is now called
 * (once, at module scope, per O1) in the gh-proxy route, and referenced
 * again in the handler's own `defaultGhProxyHandlerDeps` default
 * parameter for standalone testability. No other production file is
 * allowlisted. */
const ALLOWED_LOAD_CALL_FILES: ReadonlySet<string> = new Set([
  ALLOWED_ENV_NAME_FILE,
  path.join("apps", "web", "app", "api", "gh-proxy", "[...path]", "route.ts"),
  path.join("apps", "web", "app", "api", "gh-proxy", "[...path]", "handler.ts"),
  // D#2 H14c-3-1 (C26-1/C26-2): the worker's composition root builds the one
  // config the sandbox target and its firewall policy use, from the process env.
  path.join("packages", "worker", "src", "compositionRoot.ts"),
]);
const SQL_FORBIDDEN_RE = /forward_?host|gh_?proxy|forward_?suffix/i;

interface ScanResult {
  envNameViolations: string[];
  sqlColumnViolations: string[];
  loadCallViolations: string[];
}

/** D#66 security review, should-fix 6: excludes exactly the named
 * directories in `EXCLUDED_DIR_NAMES` (which already lists `.next`) --
 * not every dot-prefixed directory. The wider check let a route under
 * any other dot-prefixed folder (e.g. `.well-known`) skip the scan
 * entirely. */
function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIR_NAMES.has(name);
}

function isTestFile(relPath: string): boolean {
  return /(^|[\\/])(test|tests)([\\/]|$)/.test(relPath) || /\.test\.[a-z]+$/.test(relPath);
}

function walk(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function expandGlobDir(root: string, globDir: string): string[] {
  const parts = globDir.split("/");
  let current = [root];
  for (const part of parts) {
    if (part === "*") {
      const next: string[] = [];
      for (const base of current) {
        let entries: import("node:fs").Dirent[];
        try {
          entries = readdirSync(base, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.isDirectory()) next.push(path.join(base, entry.name));
        }
      }
      current = next;
    } else {
      current = current.map((base) => path.join(base, part));
    }
  }
  return current.filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function collectScannedFiles(root: string): string[] {
  const files: string[] = [];
  for (const globDir of SCAN_GLOB_DIRS) {
    for (const dir of expandGlobDir(root, globDir)) {
      walk(dir, files);
    }
  }
  return files
    .filter((f) => SCANNED_EXTENSIONS.has(path.extname(f)))
    .filter((f) => !isTestFile(path.relative(root, f)));
}

/**
 * D#66, Spec (Acceptance) criterion 8. Scans `root` for the three
 * "no tenant-writable path" violations. `root` is injectable so the
 * self-test below can prove the scan actually catches each violation
 * shape, against a throwaway fixture tree -- never the real repo.
 */
function scanGithubForwardSource(root: string): ScanResult {
  const envNameViolations: string[] = [];
  const sqlColumnViolations: string[] = [];
  const loadCallViolations: string[] = [];

  for (const file of collectScannedFiles(root)) {
    const relPath = path.relative(root, file);
    const source = readFileSync(file, "utf8");

    if (path.extname(file) === ".sql") {
      if (SQL_FORBIDDEN_RE.test(source)) {
        sqlColumnViolations.push(relPath);
      }
      continue;
    }

    if (relPath !== ALLOWED_ENV_NAME_FILE) {
      for (const envName of ENV_NAMES) {
        if (source.includes(envName)) {
          envNameViolations.push(relPath);
          break;
        }
      }
    }

    if (!ALLOWED_LOAD_CALL_FILES.has(relPath) && /loadGithubForwardConfig\s*\(/.test(source)) {
      loadCallViolations.push(relPath);
    }
  }

  return { envNameViolations, sqlColumnViolations, loadCallViolations };
}

/**
 * D#66, Spec (Acceptance) criterion 8: "no tenant-writable path." Scans
 * every `.ts`/`.tsx`/`.js`/`.mjs`/`.sql` file under each package's `src`
 * tree, `packages/db/migrations`, and each app's `app`, `src` or `lib`
 * tree (excluding tests, `node_modules`, `dist` and `.next`) for three
 * things -- see `SCAN_GLOB_DIRS` above for the exact directory list:
 *
 *   (a) `FX_GH_FORWARD_SUFFIX`/`FX_GH_FORWARD_HOST` appear only in
 *       `packages/runner/src/githubForwardConfig.ts`;
 *   (b) no `.sql` file names a column/setting matching
 *       `/forward_?host|gh_?proxy|forward_?suffix/i`;
 *   (c) `loadGithubForwardConfig(` is called only in the files
 *       `ALLOWED_LOAD_CALL_FILES` names -- `githubForwardConfig.ts`'s own
 *       DEFINITION, and, as of D#2 H13b (C13/C26), the gh-proxy route and
 *       handler (O1: the proxy's own, sole config source).
 */
describe("githubForwardSource scan (D#66 criterion 8)", () => {
  it("the real tree passes all three checks", () => {
    const result = scanGithubForwardSource(REPO_ROOT);
    expect(result.envNameViolations).toEqual([]);
    expect(result.sqlColumnViolations).toEqual([]);
    expect(result.loadCallViolations).toEqual([]);
  });

  describe("self-test: the scan actually catches each violation (fixture root, never the real tree)", () => {
    let fixtureRoot: string;

    beforeEach(() => {
      fixtureRoot = mkdtempSync(path.join(tmpdir(), "fx-githubforwardsource-"));
    });

    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
    });

    function write(relPath: string, content: string): void {
      const full = path.join(fixtureRoot, relPath);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
    }

    it("(a) catches FX_GH_FORWARD_SUFFIX/FX_GH_FORWARD_HOST used outside githubForwardConfig.ts", () => {
      write(
        "packages/other/src/leak.ts",
        `export const suffix = process.env.FX_GH_FORWARD_SUFFIX;\nexport const host = process.env.FX_GH_FORWARD_HOST;\n`,
      );
      const result = scanGithubForwardSource(fixtureRoot);
      expect(result.envNameViolations.length).toBeGreaterThan(0);
    });

    it("(b) catches a .sql file naming a forward-host-shaped column/setting", () => {
      write(
        "packages/db/migrations/0999_bad.sql",
        `ALTER TABLE installations ADD COLUMN github_forward_host TEXT;\n`,
      );
      const result = scanGithubForwardSource(fixtureRoot);
      expect(result.sqlColumnViolations.length).toBeGreaterThan(0);
    });

    it("(c) catches loadGithubForwardConfig( called from a production file", () => {
      write(
        "apps/fake/app/route.ts",
        `import { loadGithubForwardConfig } from "@fx/runner";\nconst config = loadGithubForwardConfig(process.env);\n`,
      );
      const result = scanGithubForwardSource(fixtureRoot);
      expect(result.loadCallViolations.length).toBeGreaterThan(0);
    });

    /**
     * D#66 security review, should-fix 6: `isExcludedDir` used to skip
     * every dot-prefixed directory, not just `.next` -- so a route under
     * a dot-prefixed folder (e.g. Next.js's own `.well-known` convention)
     * would never be scanned for a leaked env name.
     */
    it("(a) catches FX_GH_FORWARD_HOST used under a dot-prefixed directory that isn't .next", () => {
      write(
        "apps/fake/app/.well-known/x/route.ts",
        `export const host = process.env.FX_GH_FORWARD_HOST;\n`,
      );
      const result = scanGithubForwardSource(fixtureRoot);
      expect(result.envNameViolations.length).toBeGreaterThan(0);
    });

    it("a clean fixture tree passes all three checks", () => {
      write("packages/other/src/fine.ts", `export const x = 1;\n`);
      const result = scanGithubForwardSource(fixtureRoot);
      expect(result.envNameViolations).toEqual([]);
      expect(result.sqlColumnViolations).toEqual([]);
      expect(result.loadCallViolations).toEqual([]);
    });
  });
});
