// P9: the Workflow SDK routes come from the built output, never from a hand-typed list.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { loadPacks } from "../src/manifest.js";
import {
  extractWorkflowRoutes,
  MANIFEST_PATH,
  PLACEHOLDER,
  renderRoutesFile,
  routeFromManifestKey,
  WorkflowRoutesError,
  type WorkflowRoutesFile,
} from "../src/workflow-routes.js";
import { makeIo, PACKAGE_ROOT, tmpDir } from "./helpers.js";

/** A `.next` tree holding only the route map, shaped like Next's own `server/app-paths-manifest.json`. */
function fixtureBuild(keys: string[]): string {
  const dir = tmpDir("t1c_build_");
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(join(dir, MANIFEST_PATH), JSON.stringify(Object.fromEntries(keys.map((k) => [k, `app${k}.js`]))));
  return dir;
}

const KEYS = [
  "/.well-known/workflow/v1/webhook/[token]/route",
  "/.well-known/workflow/v1/step/route",
  "/.well-known/workflow/v1/flow/route",
  "/.well-known/workflow/v1/webhook/[token]/route",
  "/api/health/route",
  "/api/v1/[...path]/route",
  "/site-kit/page",
  "/.well-known/workflow/v1/page",
];

describe("extracting the routes from a build-output tree", () => {
  it("keeps route handlers under the workflow prefix, sorted, de-duplicated, with dynamic segments filled", () => {
    expect(extractWorkflowRoutes(fixtureBuild(KEYS))).toEqual([
      "/.well-known/workflow/v1/flow",
      "/.well-known/workflow/v1/step",
      `/.well-known/workflow/v1/webhook/${PLACEHOLDER}`,
    ]);
  });

  it("fills catch-all segments too and leaves ordinary ones", () => {
    expect(routeFromManifestKey("/.well-known/workflow/v1/a/[...rest]/route")).toBe(`/.well-known/workflow/v1/a/${PLACEHOLDER}`);
    expect(routeFromManifestKey("/.well-known/workflow/v1/a/[[...rest]]/route")).toBe(`/.well-known/workflow/v1/a/${PLACEHOLDER}`);
    expect(routeFromManifestKey("/.well-known/workflow/v1/step/route")).toBe("/.well-known/workflow/v1/step");
    expect(routeFromManifestKey("/api/health/route")).toBeNull();
    expect(routeFromManifestKey("/.well-known/workflow/v1/step/page")).toBeNull();
  });

  it("fails rather than write an empty list: no build, a build without workflow routes, a manifest that is not a map", () => {
    expect(() => extractWorkflowRoutes(join(tmpDir("t1c_none_"), "nope"))).toThrow(WorkflowRoutesError);
    expect(() => extractWorkflowRoutes(fixtureBuild(["/api/health/route"]))).toThrow("lists no /.well-known/workflow/ route");
    const dir = tmpDir("t1c_bad_");
    mkdirSync(join(dir, "server"), { recursive: true });
    writeFileSync(join(dir, MANIFEST_PATH), "[]");
    expect(() => extractWorkflowRoutes(dir)).toThrow("not a route map");
    writeFileSync(join(dir, MANIFEST_PATH), "{");
    expect(() => extractWorkflowRoutes(dir)).toThrow("not valid JSON");
  });
});

describe("the workflow-routes command", () => {
  it("writes the file, and --check passes on it and fails when it is stale or missing", async () => {
    const build = fixtureBuild(KEYS);
    const out = join(tmpDir("t1c_out_"), "routes.json");
    const { io, out: stdout, err } = makeIo(PACKAGE_ROOT);
    expect(await main(["workflow-routes", "--build-dir", build, "--out", out], io)).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(renderRoutesFile(extractWorkflowRoutes(build)));
    expect(stdout.at(-1)).toContain("wrote");
    expect(await main(["workflow-routes", "--build-dir", build, "--out", out, "--check"], io)).toBe(0);

    writeFileSync(out, `${JSON.stringify({ source: "x", routes: ["/.well-known/workflow/v1/flow"] })}\n`);
    expect(await main(["workflow-routes", "--build-dir", build, "--out", out, "--check"], io)).toBe(1);
    expect(err.at(-1)).toContain("out of date");
    expect(await main(["workflow-routes", "--build-dir", build, "--out", join(tmpDir("t1c_gone_"), "none.json"), "--check"], io)).toBe(1);
  });

  it("is a usage error without --build-dir, or --check without --out, and a clear error for a missing build", async () => {
    const { io, err } = makeIo(PACKAGE_ROOT);
    expect(await main(["workflow-routes"], io)).toBe(2);
    expect(await main(["workflow-routes", "--build-dir", "x", "--check"], io)).toBe(2);
    expect(await main(["workflow-routes", "--build-dir", join(tmpDir("t1c_nb_"), "missing")], io)).toBe(2);
    expect(err.join("\n")).toContain("no build output");
  });

  it("prints the list without --out", async () => {
    const { io, out } = makeIo(PACKAGE_ROOT);
    expect(await main(["workflow-routes", "--build-dir", fixtureBuild(KEYS)], io)).toBe(0);
    expect((JSON.parse(out.join("\n")) as WorkflowRoutesFile).routes).toHaveLength(3);
  });
});

describe("the committed list", () => {
  const file = JSON.parse(readFileSync(join(PACKAGE_ROOT, "packs", "platform", "workflow-routes.json"), "utf8")) as WorkflowRoutesFile;
  const platform = loadPacks(join(PACKAGE_ROOT, "packs")).find((p) => p.id === "platform");

  it("is non-empty, under the workflow prefix, sorted, and in the exact form the command writes", () => {
    expect(file.routes.length).toBeGreaterThan(0);
    expect(file.routes.every((r) => r.startsWith("/.well-known/workflow/"))).toBe(true);
    expect([...file.routes].sort()).toEqual(file.routes);
    expect(readFileSync(join(PACKAGE_ROOT, "packs", "platform", "workflow-routes.json"), "utf8")).toBe(renderRoutesFile(file.routes));
  });

  it("has every route declared as a refusal probe in the platform pack", () => {
    const declared = new Set((platform?.probes ?? []).map((p) => p.path));
    for (const route of file.routes) expect(declared.has(route), route).toBe(true);
  });
});
