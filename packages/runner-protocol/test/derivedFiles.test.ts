import { describe, expect, it } from "vitest";
import { parseAcceptanceScope, pathsOutsideScope } from "../src/acceptanceScope.js";
import { derivedCandidates, parseDerivedFileRules, pathsOutsideScopeFresh, readDerivedFresh, withDerivedFiles } from "../src/derivedFiles.js";

const OPENAPI = "api/openapi.json";
const CLIENT = "client/src/generated.ts";
const ROUTE = "api/src/routes/runs.ts";

const TABLE = {
  version: 1,
  rules: [
    { id: "routes", kind: "generated", inputs: ["api/src/routes/**"], outputs: [OPENAPI, CLIENT], generators: [["pnpm", "gen-openapi"], ["pnpm", "gen"]] },
    { id: "migrations", kind: "companion", inputs: ["db/migrations/*.sql"], outputs: ["db/src/inventory.ts"] },
    { id: "errors", kind: "companion", inputs: ["lib/*/src/errors.ts"], outputs: ["lib/telemetry/src/codes.ts"] },
  ],
};
const rules = parseDerivedFileRules(TABLE)!;

describe("parseDerivedFileRules (#751)", () => {
  it("reads a well formed table", () => {
    expect(rules.map((r) => r.id)).toEqual(["routes", "migrations", "errors"]);
    expect(rules[0]!.generators).toHaveLength(2);
  });

  it("refuses the whole table for any malformed part, never a partly read one", () => {
    const bad: unknown[] = [
      null, [], "x", { version: 2, rules: [] }, { version: 1 }, { version: 1, rules: [], extra: 1 },
      { version: 1, rules: [{ ...TABLE.rules[0]!, extra: true }] },
      { version: 1, rules: [TABLE.rules[0], TABLE.rules[0]] },
      { version: 1, rules: [{ ...TABLE.rules[0]!, generators: undefined }] },
      { version: 1, rules: [{ ...TABLE.rules[1]!, generators: [["pnpm", "gen"]] }] },
      { version: 1, rules: [{ ...TABLE.rules[0]!, outputs: ["api/*.json"] }] },
      { version: 1, rules: [{ ...TABLE.rules[0]!, outputs: ["/etc/passwd"] }] },
      { version: 1, rules: [{ ...TABLE.rules[0]!, inputs: ["api/src/routes/?"] }] },
      { version: 1, rules: [{ ...TABLE.rules[0]!, generators: [["pnpm gen"]] }] },
      { version: 1, rules: [TABLE.rules[0], { ...TABLE.rules[1]!, outputs: [OPENAPI] }] },
      { version: 1, rules: [{ ...TABLE.rules[0]!, kind: "other" }] },
    ];
    for (const value of bad) expect(parseDerivedFileRules(value), JSON.stringify(value)).toBeNull();
  });
});

describe("withDerivedFiles: what the Spec writer adds", () => {
  it("adds the generated files to a Spec that lists a route", () => {
    expect(withDerivedFiles(rules, [ROUTE, "api/test/runs.test.ts"])).toEqual([ROUTE, "api/test/runs.test.ts", OPENAPI, CLIENT]);
  });

  it("adds only what the list does not already hold, and nothing twice", () => {
    expect(withDerivedFiles(rules, [ROUTE, OPENAPI])).toEqual([ROUTE, OPENAPI, CLIENT]);
    const once = withDerivedFiles(rules, [ROUTE]);
    expect(withDerivedFiles(rules, once)).toEqual(once);
  });

  it("recognises a directory or glob entry that holds a route, and a brace group", () => {
    expect(withDerivedFiles(rules, ["api/src/routes/**"])).toEqual(["api/src/routes/**", OPENAPI, CLIENT]);
    expect(withDerivedFiles(rules, ["api/src/routes/run-*.ts"])).toContain(CLIENT);
    expect(withDerivedFiles(rules, ["api/src/routes/{a,b}.ts"])).toContain(OPENAPI);
    expect(withDerivedFiles(rules, ["api/**"])).toEqual(["api/**", CLIENT]);
  });

  it("adds a companion beside its input", () => {
    expect(withDerivedFiles(rules, ["db/migrations/1010_x.sql"])).toEqual(["db/migrations/1010_x.sql", "db/src/inventory.ts"]);
    expect(withDerivedFiles(rules, ["lib/api/src/errors.ts"])).toContain("lib/telemetry/src/codes.ts");
  });

  it("leaves a list with no input, a list it cannot read and an empty table exactly as given", () => {
    expect(withDerivedFiles(rules, ["web/page.tsx"])).toEqual(["web/page.tsx"]);
    expect(withDerivedFiles(rules, ["api/src/routes/x.ts?"])).toEqual(["api/src/routes/x.ts?"]);
    expect(withDerivedFiles(rules, [])).toEqual([]);
    expect(withDerivedFiles([], [ROUTE])).toEqual([ROUTE]);
  });

  it("returns a list the parser reads", () => {
    expect(parseAcceptanceScope(withDerivedFiles(rules, [ROUTE])).kind).toBe("known");
  });
});

describe("the guards: pathsOutsideScopeFresh", () => {
  const scope = parseAcceptanceScope([ROUTE, "api/test/runs.test.ts"]);

  it("holds a generated file out of scope with no vouching, exactly as before", () => {
    const changed = [ROUTE, OPENAPI, CLIENT];
    expect(pathsOutsideScopeFresh(rules, scope, changed, [])).toEqual([OPENAPI, CLIENT]);
    expect(pathsOutsideScopeFresh(rules, scope, changed, [])).toEqual(pathsOutsideScope(scope, changed));
  });

  it("counts a vouched generated file in scope when its rule's input is in scope, and only that file", () => {
    const changed = [ROUTE, OPENAPI, CLIENT];
    expect(pathsOutsideScopeFresh(rules, scope, changed, [OPENAPI, CLIENT])).toEqual([]);
    expect(pathsOutsideScopeFresh(rules, scope, changed, [CLIENT])).toEqual([OPENAPI]);
  });

  it("lifts nothing without a table", () => {
    expect(pathsOutsideScopeFresh([], scope, [ROUTE, OPENAPI], [OPENAPI])).toEqual([OPENAPI]);
  });

  it("does not lift a file that is not an output, however it is vouched", () => {
    expect(pathsOutsideScopeFresh(rules, scope, [ROUTE, "api/src/openapi.ts"], ["api/src/openapi.ts"])).toEqual(["api/src/openapi.ts"]);
  });

  it("does not lift a generated file when no input of its rule changed in scope", () => {
    expect(pathsOutsideScopeFresh(rules, scope, [OPENAPI], [OPENAPI])).toEqual([OPENAPI]);
    // The route changed, but the Spec does not allow it: an input that is itself refused lifts nothing.
    const other = parseAcceptanceScope(["web/page.tsx"]);
    expect(pathsOutsideScopeFresh(rules, other, ["web/page.tsx", ROUTE, OPENAPI], [OPENAPI])).toEqual([ROUTE, OPENAPI]);
  });

  it("never lifts a companion file", () => {
    const s = parseAcceptanceScope(["db/migrations/1010_x.sql"]);
    expect(pathsOutsideScopeFresh(rules, s, ["db/migrations/1010_x.sql", "db/src/inventory.ts"], ["db/src/inventory.ts"])).toEqual(["db/src/inventory.ts"]);
  });

  it("finds candidates only among the outside paths of active generated rules", () => {
    expect(derivedCandidates(rules, scope, [ROUTE, OPENAPI, "x.ts"], [OPENAPI, "x.ts"]).paths).toEqual([OPENAPI]);
    expect(derivedCandidates(rules, scope, [OPENAPI], [OPENAPI]).paths).toEqual([]);
    expect(derivedCandidates(rules, { kind: "unknown" }, [ROUTE, OPENAPI], [OPENAPI]).paths).toEqual([]);
  });
});

describe("readDerivedFresh", () => {
  it("reads a list of distinct generated outputs", () => {
    expect(readDerivedFresh(rules, [OPENAPI, CLIENT])).toEqual([OPENAPI, CLIENT]);
  });

  it("reads nothing from anything else: a companion or unknown path, a repeat, a non-array, too many, no table", () => {
    for (const bad of [undefined, null, "x", [], [OPENAPI, "src/a.ts"], ["db/src/inventory.ts"], [OPENAPI, OPENAPI], [1], { 0: OPENAPI }, [OPENAPI, CLIENT, OPENAPI]]) expect(readDerivedFresh(rules, bad)).toEqual([]);
    expect(readDerivedFresh([], [OPENAPI])).toEqual([]);
  });
});
