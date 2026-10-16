import { describe, expect, it } from "vitest";
import { GIT_TICKET_REF_PATTERN, parseRunnerGitTicketClaims } from "../src/runnerGitTicket.js";

/** D#599 PL-2b-2: the strict claims parser takes the item's pull request branch as a ticket ref, and no other new shape. */
const RUN = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const wire = (ref: string): Record<string, unknown> => ({
  iss: "https://cloud.example.test",
  aud: "https://proxy.example.test/api/gh-proxy",
  sub: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  acct: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
  run: RUN,
  gen: 3,
  repo: { id: "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f", owner: "acme", name: "widgets" },
  ref,
  jti: "4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f80",
  iat: 1_760_000_000,
  nbf: 1_760_000_000,
  exp: 1_760_000_300,
});

describe("the ticket claims and the item pull request branch", () => {
  it("accepts fx/issue-7 and a run branch", () => {
    expect(parseRunnerGitTicketClaims(wire("fx/issue-7"))?.ref).toBe("fx/issue-7");
    expect(parseRunnerGitTicketClaims(wire(`fx/${RUN}-g3`))?.ref).toBe(`fx/${RUN}-g3`);
  });

  it("refuses main, fx/issue-7/x, fx/docs/x and fx/issue-07", () => {
    for (const ref of ["main", "fx/issue-7/x", "fx/docs/x", "fx/issue-07", "fx/issue-0", "refs/heads/fx/issue-7", "fx/issue-7 ", ""]) {
      expect(parseRunnerGitTicketClaims(wire(ref)), JSON.stringify(ref)).toBeNull();
    }
  });

  it("the exported pattern agrees", () => {
    expect(GIT_TICKET_REF_PATTERN.test("fx/issue-7")).toBe(true);
    expect(GIT_TICKET_REF_PATTERN.test("fx/issue-07")).toBe(false);
  });
});
