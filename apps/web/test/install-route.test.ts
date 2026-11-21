import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * D#845 ON-4a: GET /install.sh in the web app. The route's behaviour (verification, caching, every refusal) is tested with the verifier in
 * packages/release-verify; this file pins what is specific to the app: the route file's exact shape and what production serves.
 */
const source = readFileSync(path.join(__dirname, "..", "app", "install.sh", "route.ts"), "utf8");

describe("apps/web/app/install.sh/route.ts", () => {
  it("is the factory with no argument, on the Node runtime, never prerendered", () => {
    expect(source).toContain("export const GET = createInstallScriptRoute();");
    expect(source).toContain('export const runtime = "nodejs";');
    expect(source).toContain('export const dynamic = "force-dynamic";');
    expect(source.match(/createInstallScriptRoute\(/g)).toHaveLength(1);
  });

  it("takes the factory from the neutral verifier package and never from the local runner", () => {
    expect(source).toContain('from "@fulcrumaxe/release-verify/installRoute"');
    expect(source).not.toMatch(/fx-runner/);
  });

  it("answers, with the production build (no release address yet), a 200 refusal script that exits 1", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { GET } = await import("../app/install.sh/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-fx-install-state")).toBe("not_configured");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const ran = spawnSync("sh", ["-c", await res.text()], { encoding: "utf8" });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("fx-runner install: not_configured:");
  });
});
