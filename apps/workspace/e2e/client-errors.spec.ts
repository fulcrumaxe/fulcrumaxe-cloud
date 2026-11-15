// apps/workspace/e2e/client-errors.spec.ts
//
// A script error thrown in the running workspace reaches the server as one class report on POST /api/rum, and a
// burst of the same error adds nothing. The report carries a code and a window id only: the message thrown here
// carries a marker that must not appear anywhere in the request.

import { test, expect, type Request } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const MARKER = "ghp_MARKER_must_not_leave_the_page";

test.describe("client errors", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "viewport-independent");
  });

  test("an error thrown in the page sends exactly one class report, with none of the message", async ({ page }) => {
    const reports: Request[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/rum" && r.method() === "POST" && (r.postData() ?? "").includes("client_error")) reports.push(r);
    });
    await bootToDesktop(page);

    await page.evaluate((marker) => {
      for (let i = 0; i < 20; i++) queueMicrotask(() => { throw new Error(`boom ${marker}`); });
    }, MARKER);
    await expect.poll(() => reports.length).toBe(1);
    // Let any extra report arrive before counting again.
    await page.waitForTimeout(500);
    expect(reports).toHaveLength(1);

    const body = reports[0]!.postData() ?? "";
    expect(JSON.parse(body)).toEqual({ kind: "client_error", code: "client.script_error", window: "shell" });
    expect(body).not.toContain(MARKER);
    expect(reports[0]!.headers()["content-type"]).toContain("application/json");
  });
});
