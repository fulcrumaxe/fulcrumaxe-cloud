import { readFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = new URL("..", import.meta.url).pathname;

/**
 * Spec H04 fix-round item 1 (CWE-489): `src/select.ts` used to statically
 * import `./local/index.js`, so anything that imports `selectRuntime` (e.g.
 * a future `apps/web` route) would bundle the local-dev runner and
 * `@anthropic-ai/claude-agent-sdk` right along with it — a 1.68 MB pull-in
 * the marker check couldn't even see, because `FX_LOCAL_RUNNER_MARKER` was
 * an unused named export that tree-shook away while the SDK import (used by
 * `createLocalRuntime`, which the bundler kept because something still
 * imported IT) stayed in.
 *
 * This bundles the actual production-facing entry point with esbuild — the
 * same tool + the same target file the reviewer used — and fails if either
 * signal shows up: the marker string, or a distinctive SDK identifier. It
 * must go red the moment a static import of the local runner comes back
 * (see the second test below, which proves exactly that by bundling a
 * fixture file that reintroduces the import this fix removed).
 */
describe("select.ts bundle isolation (Spec H04 fix-round item 1, CWE-489)", () => {
  it("bundling src/select.ts pulls in neither the local-runner marker nor the SDK", async () => {
    const result = await esbuild.build({
      entryPoints: [path.join(PACKAGE_ROOT, "src", "select.ts")],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      minify: true,
      treeShaking: true,
      logLevel: "silent",
    });
    const output = result.outputFiles[0].text;

    expect(output).not.toContain("FX_LOCAL_RUNNER_MARKER");
    expect(output).not.toContain("claude-agent-sdk");
    // The SDK's own package name would appear verbatim in the bundle as a
    // comment/specifier if esbuild inlined it; this is a second, narrower
    // signal in case the first ever changes shape.
    expect(output).not.toMatch(/anthropic-ai\/claude-agent-sdk/);
  });

  it("a fixture that reintroduces the static import goes red (proves the check isn't vacuous)", async () => {
    const result = await esbuild.build({
      stdin: {
        contents: `
          export { createLocalRuntime, FX_LOCAL_RUNNER_MARKER } from ${JSON.stringify(
            path.join(PACKAGE_ROOT, "src", "local", "index.ts"),
          )};
        `,
        loader: "ts",
        resolveDir: PACKAGE_ROOT,
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      minify: true,
      treeShaking: true,
      logLevel: "silent",
    });
    const output = result.outputFiles[0].text;

    expect(output).toContain("FX_LOCAL_RUNNER_MARKER");
  });

  it("the tree-shaking case (fix-round 2 item 7): importing ONLY createLocalRuntime, with no re-export of the marker, still keeps the marker alive under minification", async () => {
    // Stronger than the fixture above: that one re-exports
    // FX_LOCAL_RUNNER_MARKER directly alongside createLocalRuntime, so its
    // survival doesn't actually prove anything about tree-shaking — a
    // bundler keeps a re-exported name because something asked for it BY
    // NAME, exactly like it always did for the original bug. This fixture
    // asks for createLocalRuntime only. The marker constant has no export
    // path into this bundle at all except through createLocalRuntime's own
    // function body (`markerLiveInBundle()`, in src/local/index.ts) — so
    // its presence here is specifically what proves the embedding fix
    // (not re-export) is what keeps it alive.
    const result = await esbuild.build({
      stdin: {
        contents: `
          export { createLocalRuntime } from ${JSON.stringify(
            path.join(PACKAGE_ROOT, "src", "local", "index.ts"),
          )};
        `,
        loader: "ts",
        resolveDir: PACKAGE_ROOT,
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      minify: true,
      treeShaking: true,
      logLevel: "silent",
    });
    const output = result.outputFiles[0].text;

    expect(output).toContain("FX_LOCAL_RUNNER_MARKER");
  });

  it("select.ts's own source has no static import of ./local", () => {
    // Belt-and-suspenders source check, cheaper than a bundle build, so a
    // regression here is caught even faster than the bundle test above.
    const source = readFileSync(path.join(PACKAGE_ROOT, "src", "select.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']\.\/local\//);
  });
});
