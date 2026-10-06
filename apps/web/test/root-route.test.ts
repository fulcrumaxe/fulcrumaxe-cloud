import { describe, expect, it } from "vitest";
import { GET, dynamic } from "../app/route";
import { SHELL_SECURITY_HEADERS } from "../lib/shell/headers";

/**
 * D#37 WS-C2 criterion 1: "apps/web serves the built workspace: `/`
 * returns the filtered `index.html` (`Cache-Control: no-cache`)."
 *
 * `WORKSPACE_INDEX_HTML` (app/_generated/workspace-index.ts) is
 * regenerated from the real apps/workspace tree before this test runs
 * (vitest.workspace.ts's globalSetup entry for the "web" project calls
 * apps/web/scripts/copy-workspace.mjs, which itself runs WS-A1's
 * checks.mjs --import/--ship and throws if either fails) -- so a
 * passing run here is evidence against the CURRENT tree, not a stale
 * committed copy.
 */
describe("GET /", () => {
  it("is static (no per-request computation)", () => {
    expect(dynamic).toBe("force-static");
  });

  it("returns the built workspace index.html with Cache-Control: no-cache", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/i);
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
    // The filtered build keeps the shipped shell's own boot entry point
    // and drops every app not in profiles/cloud.json's app_modules.
    expect(body).toContain('src="core/boot.js"');
    expect(body).not.toContain("apps/terminal/");
  });

  it("carries the criterion-13 security headers (defense in depth, same as every other shell route)", async () => {
    const res = GET();
    for (const { key, value } of SHELL_SECURITY_HEADERS) {
      expect(res.headers.get(key.toLowerCase())).toBe(value);
    }
  });
});
