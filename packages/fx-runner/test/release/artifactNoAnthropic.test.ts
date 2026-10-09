import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { bundleRunner } from "../../scripts/build-sea.mjs";
import { SDK_SIGNALS, sdkTraces } from "../helpers/sdkTraces.js";

// R6-1 acceptance 3. The runner never bundles, ships or fetches the Claude Agent SDK (it drives the Claude CLI the person installed). The built
// executable and release files are scanned in seaReal.test.ts; this file scans the bundle (fast, and on every platform) and proves the scan is not vacuous.
const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME_DIR = path.join(PACKAGE_DIR, "..", "runtime");

describe("artifactNoAnthropic", () => {
  it("the release bundle has no @anthropic-ai path and no distinctive SDK identifier", async () => {
    const bundle = await bundleRunner(1780000000);
    expect(bundle.length).toBeGreaterThan(100_000);
    expect(sdkTraces(bundle)).toEqual([]);
  });

  it("the package declares no @anthropic-ai dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies });
    expect(names.filter((name) => name.startsWith("@anthropic-ai/"))).toEqual([]);
  });

  it("goes red when the SDK is bundled in (the scan is not vacuous)", async () => {
    const result = await build({
      stdin: { contents: `export { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";`, loader: "ts", resolveDir: RUNTIME_DIR },
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
    const traces = sdkTraces(result.outputFiles[0]!.text);
    expect(traces).toContain("createSdkMcpServer");
    expect(traces.length).toBeGreaterThan(0);
  });

  it("goes red for each signal on its own", () => {
    for (const signal of SDK_SIGNALS) expect(sdkTraces(`x ${signal} y`)).toContain(signal);
  });
});
