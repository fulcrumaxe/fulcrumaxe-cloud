import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildChildEnv, launchOptions } from "../browser/playwright-driver.js";

const SRC = path.resolve(import.meta.dirname, "../../src");
const PKG = path.resolve(import.meta.dirname, "../..");

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(full)));
    else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Lines whose evaluate() first argument is a `${}` template or a `+` concatenation. */
export function nonConstantEvaluates(source: string): string[] {
  // evaluate(<script>...) and evaluateJson(<page>, <script>, ...): the script is the argument checked.
  const re = /evaluate(?:(?:Json|Audit)\(\s*[^,]+,)?\(?\s*(`[^`]*\$\{|(?:"[^"]*"|'[^']*'|[^,)"'])*\+)/g;
  return [...source.matchAll(re)].map((m) => m[0]);
}

describe("browser seam guards", () => {
  it("evaluate scripts in src are constants (no template interpolation, no concatenation)", async () => {
    const bad: string[] = [];
    for (const file of await tsFiles(SRC)) {
      for (const hit of nonConstantEvaluates(await fs.readFile(file, "utf8"))) bad.push(`${path.relative(SRC, file)}: ${hit}`);
    }
    expect(bad).toEqual([]);
  });

  it("the scan flags interpolation and concatenation", () => {
    expect(nonConstantEvaluates("page.evaluate(`x(${theme})`)")).toHaveLength(1);
    expect(nonConstantEvaluates('page.evaluate("x(" + theme + ")")')).toHaveLength(1);
    expect(nonConstantEvaluates("page.evaluate(AUDIT, { theme })")).toEqual([]);
    expect(nonConstantEvaluates("evaluateJson(page, `() => f(\"${theme}\")`)")).toHaveLength(1);
    expect(nonConstantEvaluates('evaluateJson(page, "() => f(" + theme + ")")')).toHaveLength(1);
    expect(nonConstantEvaluates("evaluateJson(page, AUDIT, { theme })")).toEqual([]);
    expect(nonConstantEvaluates("evaluateAudit(page, `() => f(\"${theme}\")`)")).toHaveLength(1);
    expect(nonConstantEvaluates("evaluateAudit(page, AUDIT, theme)")).toEqual([]);
  });

  it("no browser is in the runtime graph", async () => {
    for (const file of await tsFiles(SRC)) expect(await fs.readFile(file, "utf8")).not.toMatch(/playwright/i);
    const pkg = JSON.parse(await fs.readFile(path.join(PKG, "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(pkg.devDependencies["playwright-core"]).toBe("1.63.0");
  });

  it("the adapter launches on the pipe transport with the Chromium sandbox on", () => {
    const opts = launchOptions({}, "/tmp/home");
    expect(opts.chromiumSandbox).toBe(true);
    expect((opts.args ?? []).join(" ")).not.toContain("remote-debugging-port");
    expect((opts.args ?? []).join(" ")).not.toContain("no-sandbox");
  });

  it("the child env is an allowlist with a fresh HOME", () => {
    const env = buildChildEnv(
      { PATH: "/bin", LANG: "C", HOME: "/root", GITHUB_TOKEN: "t", ANTHROPIC_API_KEY: "k", DATABASE_URL: "d", FX_KEK_TEST: "x" },
      "/tmp/home",
    );
    expect(env).toEqual({ HOME: "/tmp/home", PATH: "/bin", LANG: "C" });
  });
});
