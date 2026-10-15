import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OUT_PATH, SPEC_PATH, generate, type OpenApiDoc } from "../scripts/gen-client.js";
import { operations } from "../src/index.js";

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as OpenApiDoc;
const pkgRoot = path.join(path.dirname(OUT_PATH), "..");
const fixturesRoot = path.join(path.dirname(SPEC_PATH), "fixtures", "v1");

const specOps = Object.values(spec.paths).flatMap((item) =>
  Object.entries(item).map(([, op]) => op),
);
const specTokenOps = specOps.filter((op) => (op.security ?? []).some((s) => "token" in s));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

describe("generated client matches the spec", () => {
  it("src/generated.ts is exactly what the generator writes for packages/api/openapi.json", () => {
    const fresh = generate(spec);
    const committed = readFileSync(OUT_PATH, "utf8");
    expect(
      committed === fresh,
      "src/generated.ts is out of date with packages/api/openapi.json. Run: pnpm --filter @fx/api-client gen",
    ).toBe(true);
  });

  it("has one table entry per spec operation, and the token-capable ones match", () => {
    expect(Object.keys(operations).length).toBe(specOps.length);
    expect(new Set(Object.keys(operations))).toEqual(new Set(specOps.map((o) => o.operationId)));
    const tokenIds = Object.entries(operations)
      .filter(([, o]) => o.tokenAccess)
      .map(([id]) => id);
    expect(new Set(tokenIds)).toEqual(new Set(specTokenOps.map((o) => o.operationId)));
    expect(tokenIds.length).toBeGreaterThan(0);
  });

  it("carries each token operation's scope, or the self-only flag", () => {
    for (const op of specTokenOps) {
      const entry = operations[op.operationId as keyof typeof operations];
      const scope = op.security?.find((s) => "token" in s)?.token?.[0] ?? null;
      expect(entry.scope, op.operationId).toBe(scope);
      expect(entry.tokenSelfOnly, op.operationId).toBe(op["x-fx-token-self-only"] === true);
    }
    expect(operations.deleteToken.tokenSelfOnly).toBe(true);
    expect(operations.deleteToken.scope).toBeNull();
  });

  it("takes idempotency from the spec: absent means the route rejects the header", () => {
    for (const op of specOps) {
      expect(operations[op.operationId as keyof typeof operations].idempotency, op.operationId).toBe(
        op["x-fx-idempotency"] ?? "never",
      );
    }
    expect(operations.cancelRun.idempotency).not.toBe("never");
  });
});

describe("every token operation has a recorded fixture", () => {
  for (const op of specTokenOps) {
    it(op.operationId, () => {
      const dir = path.join(fixturesRoot, op.operationId);
      expect(existsSync(dir), `missing packages/api/fixtures/v1/${op.operationId}/`).toBe(true);
      expect(readdirSync(dir).length, `${dir} is empty`).toBeGreaterThan(0);
    });
  }
});

describe("package boundaries", () => {
  const files = sourceFiles(path.join(pkgRoot, "src"));
  const text = files.map((f) => readFileSync(f, "utf8")).join("\n");

  it("is private and has no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });

  it("names nothing from the CLI package", () => {
    expect(text).not.toMatch(/packages\/cli|@fx\/cli|fulcrumaxe"/);
  });

  it("never reads the process environment", () => {
    expect(text).not.toContain("process.env");
  });
});
