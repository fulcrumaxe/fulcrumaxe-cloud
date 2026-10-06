// apps/web/test/branding.test.ts
//
// D#37 Correction C19d, task WS-B1 criterion 1: "GET /api/branding
// returns exactly the six keys and values in the table: no other key,
// and no version, environment, host or account data... branding.test.ts
// pins the exact body." The six owner-ruled values below are OWNER
// DECISION, 2026-09-25 (discussioncomment-18606574), not placeholders --
// this test is the pin that keeps them from drifting.

import { describe, expect, it } from "vitest";
import { GET, dynamic } from "../app/api/branding/route";

const RULED_BODY = {
  page_title: "fulcrumaxe",
  product_name: "fulcrumaxe cloud",
  os_name: "fulcrumaxe cloud",
  system_tag: "fulcrumaxe cloud",
  copyright: "© fulcrumaxe",
  welcome_message: "Welcome to fulcrumaxe cloud.",
};

describe("D#37 C19d WS-B1 criterion 1: GET /api/branding", () => {
  it("is force-static", () => {
    expect(dynamic).toBe("force-static");
  });

  it("returns exactly the six owner-ruled keys and values -- no more, no fewer", async () => {
    const body = await GET().json();
    // toEqual is a full structural match: an extra key on either side
    // (version, env, host, account data, or the old name/shortName pair)
    // fails this just as surely as a wrong value would.
    expect(body).toEqual(RULED_BODY);
  });

  it("no longer returns the old name/shortName keys the shell never read", async () => {
    const body = await GET().json();
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("shortName");
  });
});
