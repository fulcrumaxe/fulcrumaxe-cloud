import { describe, expect, it } from "vitest";
import { SURVEY_ROLE } from "@fulcrumaxe/runner-protocol";
import { PUSHING_ROLES } from "../src/daemon/gitPath.js";
import { ROLE_TOOLS, roleToolsDigest, roleToolsFor } from "../src/job/roleTools.js";

/** D#845 ON-10a: the runner's side of the survey role's table entries. The enforcement on the machine (the confined read guard, the writable path) is ON-10c's. */
describe("the survey role on the runner", () => {
  it("holds the four read tools and no write tool, no Bash and no network tool, as one frozen table entry", () => {
    expect([...roleToolsFor(SURVEY_ROLE)]).toEqual(["Read", "Glob", "Grep", "LS"]);
    expect(Object.isFrozen(ROLE_TOOLS[SURVEY_ROLE])).toBe(true);
    expect(roleToolsDigest(SURVEY_ROLE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is never a pushing role: a survey run pushes nothing", () => {
    expect(PUSHING_ROLES.has(SURVEY_ROLE)).toBe(false);
  });
});
