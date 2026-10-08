import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint, Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import plugin from "./no-silent-catch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = JSON.parse(readFileSync(path.join(ROOT, "lint", "no-silent-catch.baseline.json"), "utf8"));
const FILE = path.join(ROOT, "packages", "demo", "src", "a.js");

/** Messages for `code` linted as FILE with the given baseline. */
function lint(code, { baseline = {} } = {}) {
  const linter = new Linter({ cwd: ROOT });
  return linter.verify(
    code,
    [
      {
        plugins: { "fx-catch": plugin },
        languageOptions: { ecmaVersion: "latest", sourceType: "module" },
        rules: { "fx-catch/no-silent-catch": ["error", { baseline }] },
      },
    ],
    { filename: FILE },
  );
}

const flagged = (code, options) => lint(code, options).length;

describe("no-silent-catch: what is flagged", () => {
  it("flags an empty catch, with or without a binding, and one that only returns a value", () => {
    expect(flagged("try { f(); } catch {}")).toBe(1);
    expect(flagged("try { f(); } catch (err) {}")).toBe(1);
    expect(flagged("function g() { try { f(); } catch (err) { return null; } }")).toBe(1);
    expect(flagged("try { f(); } catch (err) { // dropped\n }")).toBe(1);
  });

  it("flags a catch that logs below warn, or on something that is not a logger, or only mentions the name", () => {
    expect(flagged("try { f(); } catch (err) { logger.info('x'); }")).toBe(1);
    expect(flagged("try { f(); } catch (err) { console.error('x'); }")).toBe(1);
    expect(flagged("try { f(); } catch (err) { other.error('x'); }")).toBe(1);
    expect(flagged("try { f(); } catch (err) { const reportError = 1; }")).toBe(1);
  });

  it("flags a rethrow that is inside a function declared in the catch (it does not rethrow the catch)", () => {
    expect(flagged("try { f(); } catch (err) { const later = () => { throw err; }; }")).toBe(1);
  });

  it("an empty reason on the marker is not a reason", () => {
    expect(flagged("try { f(); } catch { // fx-swallow-ok:\n }")).toBe(1);
    expect(flagged("try { f(); } catch { // fx-swallow-ok\n }")).toBe(1);
  });

  it("counts each silent catch, nested ones included", () => {
    expect(flagged("try { a(); } catch {}\ntry { b(); } catch { try { c(); } catch {} }")).toBe(3);
  });
});

describe("no-silent-catch: what passes", () => {
  it("a catch marked fx-swallow-ok with a reason", () => {
    expect(flagged("try { f(); } catch {\n  // fx-swallow-ok: best-effort cleanup\n}")).toBe(0);
    expect(flagged("try { f(); } catch { /* fx-swallow-ok: best-effort cleanup */ }")).toBe(0);
  });

  it("a catch that calls reportError, bare or as a member", () => {
    expect(flagged("try { f(); } catch (err) { reportError(err, { stage: 'x' }); }")).toBe(0);
    expect(flagged("try { f(); } catch (err) { telemetry.reportError(err, { stage: 'x' }); }")).toBe(0);
    expect(flagged("try { f(); } catch (err) { reportSyncFailure(err, '/'); }")).toBe(0);
  });

  it("a catch that calls error or warn on a logger", () => {
    expect(flagged("try { f(); } catch (err) { logger.error('x.y', { error: err }); }")).toBe(0);
    expect(flagged("try { f(); } catch (err) { log.warn('x.y', { error: err }); }")).toBe(0);
    expect(flagged("try { f(); } catch (err) { this.deps.logger.warn('x.y'); }")).toBe(0);
  });

  it("a catch that rethrows, as is or wrapped", () => {
    expect(flagged("try { f(); } catch (err) { throw err; }")).toBe(0);
    expect(flagged("try { f(); } catch (err) { if (!ok(err)) throw new Error('wrapped', { cause: err }); }")).toBe(0);
  });

  it("an inner catch does not excuse the outer one, and the outer one's report does not excuse the inner", () => {
    expect(flagged("try { a(); } catch (e) { try { b(); } catch {} reportError(e, { stage: 'x' }); }")).toBe(1);
    expect(flagged("try { a(); } catch (e) { try { b(); } catch (e2) { reportError(e2, { stage: 'x' }); } }")).toBe(1);
  });
});

describe("no-silent-catch: the baseline", () => {
  const two = "try { a(); } catch {}\ntry { b(); } catch {}";
  const rel = "packages/demo/src/a.js";

  it("the rule reports only the sites beyond the file's count", () => {
    expect(flagged(two, { baseline: { [rel]: 1 } })).toBe(1);
    expect(flagged(two, { baseline: { [rel]: 2 } })).toBe(0);
    expect(flagged(two, { baseline: { "packages/demo/src/other.js": 2 } })).toBe(2);
  });

  it("a new silent catch in a baselined file is an error, wherever it sits", () => {
    const withNew = "try { new1(); } catch {}\n" + two;
    expect(flagged(withNew, { baseline: { [rel]: 2 } })).toBe(1);
  });
});

// The rule over the real tree, with no baseline applied, must find exactly the sites the baseline file lists.
// Higher means a new silent catch slipped in; lower means a fixed site is still listed (lower its count).
describe("no-silent-catch: the baseline file is exact for the tree", () => {
  it("every silent catch in the server code is in the baseline, and every baseline count is still true (the file is empty)", { timeout: 180_000 }, async () => {
    const SCOPE = ["packages/*/src/**/*.{ts,tsx,js,mjs}", "apps/web/app/**/*.{ts,tsx}", "apps/web/lib/**/*.{ts,tsx}"];
    const eslint = new ESLint({
      cwd: ROOT,
      overrideConfigFile: true,
      overrideConfig: [
        // The same ignores the repo's eslint.config.mjs applies ("**/build/**" is its generic output-directory ignore,
        // so packages/pipeline/src/build is out of the rule's reach there too), plus the tests.
        { ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/build/**", "**/*.test.*", "**/test/**", "**/fixtures/**"] },
        {
          files: SCOPE,
          languageOptions: { parser: tseslint.parser },
          plugins: { "fx-catch": plugin },
          rules: { "fx-catch/no-silent-catch": "error" },
        },
      ],
    });
    const results = await eslint.lintFiles(SCOPE);
    const found = {};
    for (const r of results) {
      const n = r.messages.filter((m) => m.ruleId === "fx-catch/no-silent-catch").length;
      if (n > 0) found[path.relative(ROOT, r.filePath).split(path.sep).join("/")] = n;
    }
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
    expect(BASELINE).toEqual({});
    expect(sorted(found)).toEqual(sorted(BASELINE));
    expect(results.length).toBeGreaterThan(100); // the scan really read the tree
  });
});
