import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { COPY, runnerSetupText } from "../src/copy.js";
import { GIT_TICKET_LIFETIME_SECONDS, GitTicketReply, RUNNER_REPLIES } from "../src/replies.js";
import { DETAILS_OF_RUN_ENDED, GIT_TICKET_PATH, GitTicketMessage, LocalOnlyEvent, PUSH_TOO_LARGE_SIZE_MB, RUNNER_MESSAGES, RUNNER_SETUP_DETAILS } from "../src/messages.js";
import { redactDeep, redactText } from "../src/redact.js";
import { g1Violations, nonStrictObjects } from "./helpers/schemaWalk.js";

/**
 * D#6 R5a-2b (C27 sections 1.1, 1.2 and 4.5): the ticket request and reply, the new `runner_setup` details, and `size_mb`.
 */

const RUN = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const TS = "2026-10-10T12:00:00.000Z";
const ended = (extra: Record<string, unknown>) => ({ seq: 4, ts: TS, type: "run_ended", ...extra });

/** A compact JWS shaped like a minted ticket (header, claims, an Ed25519-length signature), built at run time so no token-like literal sits in the source. */
function ticketShaped(): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [part({ alg: "EdDSA", typ: "fx-git-ticket+jwt", kid: "k1" }), part({ iss: "https://cloud.example.test", run: RUN, gen: 3, ref: `fx/${RUN}-g3` }), randomBytes(64).toString("base64url")].join(".");
}

describe("the git ticket request", () => {
  it("is exactly { run_id, lease_generation }, strict, on the constant path", () => {
    expect(GIT_TICKET_PATH).toBe("/api/runner/git-ticket");
    expect(RUNNER_MESSAGES.git_ticket).toBe(GitTicketMessage);
    expect(GitTicketMessage.safeParse({ run_id: RUN, lease_generation: 3 }).success).toBe(true);
    for (const bad of [{}, { run_id: RUN }, { lease_generation: 3 }, { run_id: "x", lease_generation: 3 }, { run_id: RUN, lease_generation: -1 }, { run_id: RUN, lease_generation: 1.5 }, { run_id: RUN, lease_generation: 3, repo: "acme/x" }, { run_id: RUN, lease_generation: 3, ref: "main" }]) {
      expect(GitTicketMessage.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the git ticket reply", () => {
  const good = () => ({ ticket: ticketShaped(), expires_at: TS, proxy_origin: "https://proxy.example.test" });

  it("is { ticket, expires_at, proxy_origin }, strict, and passes the G1 walk (its field is not named like a credential)", () => {
    expect(RUNNER_REPLIES.git_ticket).toBe(GitTicketReply);
    expect(GitTicketReply.safeParse(good()).success).toBe(true);
    expect(nonStrictObjects(GitTicketReply)).toEqual([]);
    expect(g1Violations(GitTicketReply)).toEqual([]);
    expect(GitTicketReply.safeParse({ ...good(), extra: 1 }).success).toBe(false);
  });

  it("refuses a ticket that is not a compact JWS, an over-long one, a non-https or path-carrying origin, and a bad time", () => {
    for (const ticket of ["", "abc", "a.b", "a.b.c.d", "a b.c.d", `${"a".repeat(2049)}.b.c`]) expect(GitTicketReply.safeParse({ ...good(), ticket }).success, ticket.slice(0, 10)).toBe(false);
    for (const proxy_origin of ["http://proxy.example.test", "https://proxy.example.test/api", "https://user@proxy.example.test", "proxy.example.test", "https://", ""]) {
      expect(GitTicketReply.safeParse({ ...good(), proxy_origin }).success, proxy_origin).toBe(false);
    }
    expect(GitTicketReply.safeParse({ ...good(), expires_at: "tomorrow" }).success).toBe(false);
  });

  it("the ticket lifetime in the protocol is the 5 minutes of the ruling", () => {
    expect(GIT_TICKET_LIFETIME_SECONDS).toBe(300);
  });
});

describe("G2: a minted ticket is removed by redaction (it is a JWT)", () => {
  it("redactText and redactDeep replace a ticket wherever it appears", () => {
    const ticket = ticketShaped();
    expect(redactText(`git said: header fx-git-ticket: ${ticket} failed`, [])).not.toContain(ticket);
    expect(redactText(ticket, [])).not.toContain(ticket.split(".")[2]!);
    const deep = redactDeep({ a: { b: [`x ${ticket} y`] }, c: ticket }, []);
    expect(JSON.stringify(deep)).not.toContain(ticket.split(".")[1]!);
  });
});

describe("the new runner_setup details and size_mb (C27 section 4.5)", () => {
  const NEW = ["git_proxy_unpinned", "git_ticket_refused", "path_a_no_mirror", "clone_limited", "push_too_large", "push_incomplete"];

  it("RUNNER_SETUP_DETAILS gains exactly the six, after every earlier detail (and before the later model_unsupported)", () => {
    expect(RUNNER_SETUP_DETAILS.slice(-7, -1)).toEqual(NEW);
    expect(RUNNER_SETUP_DETAILS.slice(0, -7)).toEqual(["sandbox_unavailable", "claude_binary_missing", "claude_version_unsupported", "claude_flags_unsupported", "auth_missing", "bad_start_options", "no_init_line", "permission_mode_forced", "continuation_branch_missing", "other"]);
    expect(DETAILS_OF_RUN_ENDED.runner_setup).toEqual(RUNNER_SETUP_DETAILS);
  });

  it("each is accepted on runner_setup and on no other reason", () => {
    for (const detail of NEW.filter((d) => d !== "push_too_large")) {
      expect(LocalOnlyEvent.safeParse(ended({ reason: "runner_setup", detail })).success, detail).toBe(true);
      for (const reason of ["job_refused", "agent_failed", "wall_clock", "runner_shutdown", "repo_not_private"]) expect(LocalOnlyEvent.safeParse(ended({ reason, detail })).success, `${reason}/${detail}`).toBe(false);
    }
  });

  it("size_mb is allowed with push_too_large and with nothing else", () => {
    expect(LocalOnlyEvent.safeParse(ended({ reason: "runner_setup", detail: "push_too_large", size_mb: 5 })).success).toBe(true);
    expect(LocalOnlyEvent.safeParse(ended({ reason: "runner_setup", detail: "push_too_large" })).success).toBe(true);
    // Any other detail, no detail, another reason, or another event type: refused.
    for (const detail of RUNNER_SETUP_DETAILS.filter((d) => d !== "push_too_large")) expect(LocalOnlyEvent.safeParse(ended({ reason: "runner_setup", detail, size_mb: 5 })).success, detail).toBe(false);
    expect(LocalOnlyEvent.safeParse(ended({ reason: "runner_setup", size_mb: 5 })).success).toBe(false);
    expect(LocalOnlyEvent.safeParse(ended({ reason: "agent_failed", size_mb: 5 })).success).toBe(false);
    expect(LocalOnlyEvent.safeParse(ended({ reason: "job_refused", detail: "duplicate_job", size_mb: 5 })).success).toBe(false);
    expect(LocalOnlyEvent.safeParse({ seq: 0, ts: TS, type: "usage", size_mb: 5 }).success).toBe(false);
    expect(LocalOnlyEvent.safeParse({ seq: 0, ts: TS, type: "tool_use", tool_name: "Edit", size_mb: 5 }).success).toBe(false);
  });

  it("size_mb is a whole number of MB from 5 to 10,000", () => {
    expect(PUSH_TOO_LARGE_SIZE_MB).toEqual({ min: 5, max: 10_000 });
    const base = { reason: "runner_setup", detail: "push_too_large" };
    for (const ok of [5, 6, 4096, 10_000]) expect(LocalOnlyEvent.safeParse(ended({ ...base, size_mb: ok })).success, String(ok)).toBe(true);
    for (const bad of [0, 4, -5, 10_001, 5.5, "5", null, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) expect(LocalOnlyEvent.safeParse(ended({ ...base, size_mb: bad })).success, String(bad)).toBe(false);
  });

  it("the event schema still rejects an unknown key", () => {
    expect(LocalOnlyEvent.safeParse(ended({ reason: "runner_setup", detail: "clone_limited", size: 5 })).success).toBe(false);
    expect(z.object({}).strict().safeParse({}).success).toBe(true);
  });
});

describe("what the dashboard shows for a runner_setup event", () => {
  it("clone_limited shows the exact string of the ruling", () => {
    expect(COPY.cloneLimited).toBe("This repository has used today's download allowance through our proxy. The runner keeps a copy, so this is rare. It resets at 00:00 UTC.");
    expect(runnerSetupText("clone_limited")).toBe(COPY.cloneLimited);
  });

  it("push_too_large shows the Push too large string with {size} filled from size_mb", () => {
    expect(runnerSetupText("push_too_large", 7)).toBe("This push is 7 MB; the limit through our proxy is 4 MB. A person can push this commit, or you can switch this repo to local-only (auto-merge turns off).");
    expect(runnerSetupText("push_too_large", 7)).not.toContain("{");
  });

  it("every other detail shows the setup sentence with the closed code as sent, and nothing shows null, undefined or a brace", () => {
    for (const detail of RUNNER_SETUP_DETAILS.filter((d) => d !== "clone_limited" && d !== "push_too_large")) {
      expect(runnerSetupText(detail)).toBe(`Your runner could not start the agent (${detail}). Check the runner's setup, then retry.`);
    }
    // A size that is missing or out of range falls back to the plain code instead of printing "undefined MB".
    for (const text of [runnerSetupText("push_too_large"), runnerSetupText("push_too_large", 0), runnerSetupText("push_too_large", Number.NaN), runnerSetupText("clone_limited"), runnerSetupText("other")]) {
      expect(text).not.toMatch(/undefined|null|NaN|\{|\}/);
    }
  });
});
