import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSpecCriteria } from "../../../core/src/verify/journeys.js";
import { assembleSpecBody } from "../../src/plan/spec.js";

// The verify step reads the numbered criteria out of the stored Spec body. The core fixture is this writer's real output; this test fails when the writer's
// shape changes, so the parser and its fixture cannot drift from the writer unseen.
const FIXTURE = new URL("../../../core/test/fixtures/verify/realSpecBody.txt", import.meta.url);

const SPEC_TEXT = [
  "## Overview",
  "",
  "1. This numbered line is background, not a criterion.",
  "",
  "## Acceptance criteria",
  "",
  "1. The settings page shows a Save button",
  "2. Saving keeps the value after a reload, shown as in:",
  "",
  "```ts",
  "1. not a criterion, a code sample",
  "```",
  "",
  "3. `pickRepoId([])` returns `null`",
  "",
  "## Notes",
  "",
  "1. A note, outside the criteria section.",
].join("\n");

function realBody(): string {
  return assembleSpecBody({
    expectedRoles: ["technical-architect", "security-expert"],
    postedRoles: new Set(["technical-architect", "security-expert"]),
    missingReasons: {},
    round2Ran: true,
    nonce: "0123456789abcdef01234567",
    summary: "1. The panel agrees on the plan.\n2. Keep it small.",
    spec: SPEC_TEXT,
    acceptanceFiles: ["apps/web/app/settings/page.tsx", "apps/web/test/settings.test.ts"],
  });
}

describe("the Spec body the verify step reads", () => {
  it("matches the captured fixture byte for byte", () => {
    if (process.env.UPDATE_SPEC_FIXTURE === "1") writeFileSync(FIXTURE, realBody());
    expect(readFileSync(FIXTURE, "utf8")).toBe(realBody());
  });
  it("gives the criteria of the quoted Spec, and only those", () => {
    expect(parseSpecCriteria(realBody())).toEqual(["The settings page shows a Save button", "Saving keeps the value after a reload, shown as in:", "`pickRepoId([])` returns `null`"]);
  });
});
