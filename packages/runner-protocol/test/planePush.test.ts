import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_PLANE_PUSH_REFUSALS, PLANE_PUSH_PAIRING_PATH, PLANE_PUSH_PHASES, PLANE_PUSH_REPORT_PATH, PLANE_PUSH_TOKEN_PATH, PlanePushPairingMessage, PlanePushReportMessage, PlanePushTokenMessage, RUNNER_MESSAGES } from "../src/messages.js";
import { MAX_PLANE_PUSH_GLOBS, PlanePushPairingReply, PlanePushReportReply, PlanePushTokenReply, RUNNER_REPLIES } from "../src/replies.js";
import { pairingDigest } from "../src/pairingDigest.js";
import { fieldPaths, g1Violations, nonStrictObjects } from "./helpers/schemaWalk.js";

/** D#598 P1f-2: the two public-push messages and their replies. */

const RUN = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const tokenLike = ["g", "hs", "x".repeat(30)].join("_"); // gitleaks:allow
const DIGEST = "a".repeat(64);

describe("the token request", () => {
  it("is exactly { run_id, lease_generation }, strict, on the constant path", () => {
    expect(PLANE_PUSH_TOKEN_PATH).toBe("/api/runner/plane-push-token");
    expect(RUNNER_MESSAGES.plane_push_token).toBe(PlanePushTokenMessage);
    expect(PlanePushTokenMessage.safeParse({ run_id: RUN, lease_generation: 1 }).success).toBe(true);
    for (const bad of [{}, { run_id: RUN }, { run_id: RUN, lease_generation: 1, repo: "a/b" }, { run_id: RUN, lease_generation: 1, branch: "x" }, { run_id: "x", lease_generation: 1 }]) {
      expect(PlanePushTokenMessage.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the report", () => {
  const base = { run_id: RUN, lease_generation: 2, phase: "pushed", branch: "fx/p-0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", head_sha: SHA_A, tip_sha: SHA_B, pairing_digest: DIGEST };

  it("is strict, on the constant path, and takes the seven phases", () => {
    expect(PLANE_PUSH_REPORT_PATH).toBe("/api/runner/plane-push-report");
    expect(RUNNER_MESSAGES.plane_push_report).toBe(PlanePushReportMessage);
    expect([...PLANE_PUSH_PHASES]).toEqual(["building", "scanning", "pushed", "pr_opened", "refused", "pr_failed", "no_change"]);
    for (const phase of PLANE_PUSH_PHASES) expect(PlanePushReportMessage.safeParse({ ...base, phase }).success, phase).toBe(true);
    expect(PlanePushReportMessage.safeParse({ ...base, phase: "merged" }).success).toBe(false);
    expect(nonStrictObjects(PlanePushReportMessage)).toEqual([]);
  });

  it("rejects a content field and a diff field, under any name that could carry file text", () => {
    for (const key of ["content", "diff", "text", "output", "patch", "matched", "value", "message", "body", "token"]) {
      expect(PlanePushReportMessage.safeParse({ ...base, [key]: "anything" }).success, key).toBe(false);
    }
  });

  it("holds at most 100 refusals of exactly { kind, place, rule_key }, and refuses any other field inside one", () => {
    const one = { kind: "identifier", place: "src/a.ts:12", rule_key: "ident.internal-name" };
    expect(MAX_PLANE_PUSH_REFUSALS).toBe(100);
    expect(PlanePushReportMessage.safeParse({ ...base, phase: "refused", code: "scan_refused", refusals: Array.from({ length: 100 }, () => one) }).success).toBe(true);
    expect(PlanePushReportMessage.safeParse({ ...base, phase: "refused", code: "scan_refused", refusals: Array.from({ length: 101 }, () => one) }).success).toBe(false);
    expect(PlanePushReportMessage.safeParse({ ...base, phase: "refused", code: "scan_refused", refusals: [{ ...one, value: "secret" }] }).success).toBe(false);
    expect(PlanePushReportMessage.safeParse({ ...base, phase: "refused", code: "scan_refused", refusals: [{ ...one, place: "a\nb" }] }).success).toBe(false);
  });

  it("needs the pairing digest (64 lowercase hex) for pushed, pr_failed and pr_opened, and takes it on any phase", () => {
    const { pairing_digest: _drop, ...bare } = base;
    for (const phase of ["pushed", "pr_failed", "pr_opened"]) {
      expect(PlanePushReportMessage.safeParse({ ...bare, phase, pr_number: 4 }).success, phase).toBe(false);
      expect(PlanePushReportMessage.safeParse({ ...base, phase, pr_number: 4 }).success, phase).toBe(true);
    }
    for (const phase of ["building", "scanning", "refused", "no_change"]) {
      expect(PlanePushReportMessage.safeParse({ ...bare, phase }).success, phase).toBe(true);
      expect(PlanePushReportMessage.safeParse({ ...bare, phase, pairing_digest: DIGEST }).success, phase).toBe(true);
    }
    for (const bad of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), "", 7]) {
      expect(PlanePushReportMessage.safeParse({ ...base, pairing_digest: bad }).success, String(bad)).toBe(false);
    }
  });

  it("bounds the shas, the pull request number and the code", () => {
    for (const bad of [{ head_sha: "xyz" }, { head_sha: "A".repeat(40) }, { tip_sha: "a".repeat(41) }, { pr_number: 0 }, { pr_number: 2 ** 31 }, { code: "Bad Code" }, { branch: "../x" }, { token_revoked: "yes" }]) {
      expect(PlanePushReportMessage.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(PlanePushReportMessage.safeParse({ ...base, phase: "pr_opened", pr_number: 2 ** 31 - 1, token_revoked: false }).success).toBe(true);
  });
});

describe("the replies", () => {
  const good = () => ({
    token: tokenLike,
    expires_at: "2026-10-16T12:00:00.000Z",
    code_repo: "acme/widgets",
    branch: "fx/p-0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e",
    base: "main",
    pr: { title: "Add the export button", body: "Prepared by a run." },
    identity: { name: "Fulcrumaxe Bot", email: "bot@example.com" },
  });

  it("the token reply is strict and exactly { token, expires_at, code_repo, branch, base: main, pr, identity }", () => {
    expect(RUNNER_REPLIES.plane_push_token).toBe(PlanePushTokenReply);
    expect(PlanePushTokenReply.safeParse(good()).success).toBe(true);
    expect(nonStrictObjects(PlanePushTokenReply)).toEqual([]);
    for (const bad of [{ extra: 1 }, { base: "develop" }, { branch: "fx/issue-4" }, { code_repo: "a/b/c" }, { token: "short" }, { token: "has space in it and more padding" }, { expires_at: "soon" }]) {
      expect(PlanePushTokenReply.safeParse({ ...good(), ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the token reply needs pr and identity, each strict, with a one-line title of at most 100 characters and a platform identity of the route's patterns", () => {
    const { pr: _pr, ...noPr } = good();
    const { identity: _identity, ...noIdentity } = good();
    expect(PlanePushTokenReply.safeParse(noPr).success).toBe(false);
    expect(PlanePushTokenReply.safeParse(noIdentity).success).toBe(false);
    const bads: Array<Record<string, unknown>> = [
      { pr: { title: "x", body: "y", extra: 1 } },
      { pr: { title: "", body: "y" } },
      { pr: { title: "x", body: "" } },
      { pr: { title: "a".repeat(101), body: "y" } },
      { pr: { title: "two\nlines", body: "y" } },
      { pr: { title: "nul\u0000", body: "y" } },
      { pr: { title: "x", body: "nul\u0000" } },
      { pr: { title: "x", body: "b".repeat(2001) } },
      { identity: { name: "Bot", email: "bot@example.com", extra: 1 } },
      { identity: { name: "", email: "bot@example.com" } },
      { identity: { name: "Bo<t>", email: "bot@example.com" } },
      { identity: { name: "Bot", email: "not an email" } },
      { identity: { name: "Bot", email: "bot@exa mple.com" } },
      { identity: { name: "Bot" } },
    ];
    for (const bad of bads) expect(PlanePushTokenReply.safeParse({ ...good(), ...bad }).success, JSON.stringify(bad)).toBe(false);
    expect(PlanePushTokenReply.safeParse({ ...good(), pr: { title: "a".repeat(100), body: "multi\nline body" } }).success).toBe(true);
  });

  it("the report reply is exactly { recorded: true }", () => {
    expect(RUNNER_REPLIES.plane_push_report).toBe(PlanePushReportReply);
    expect(PlanePushReportReply.safeParse({ recorded: true }).success).toBe(true);
    expect(PlanePushReportReply.safeParse({ recorded: false }).success).toBe(false);
    expect(PlanePushReportReply.safeParse({ recorded: true, state: "pushed" }).success).toBe(false);
  });
});

describe("G1 stays closed in the runner-to-cloud direction", () => {
  it("no runner-to-cloud message has a field named token (only token_revoked, a boolean, is allowed)", () => {
    for (const [name, schema] of Object.entries(RUNNER_MESSAGES)) {
      const names = fieldPaths(schema as z.ZodTypeAny).map((p) => p.slice(p.lastIndexOf(".") + 1));
      expect(names, name).not.toContain("token");
    }
    expect(g1Violations(PlanePushReportMessage)).toEqual([]);
    expect(PlanePushReportMessage.innerType().shape.token_revoked.safeParse(["g", "hs", "abcdefghijklmnopqrstuvwxyz0123"].join("_")).success).toBe(false);
  });

  it("only the token reply carries a field named token, apart from the wake grant's token on hello and claim", () => {
    const paths = (schema: z.ZodTypeAny): string[] => (schema instanceof z.ZodUnion ? (schema.options as z.ZodTypeAny[]).flatMap(paths) : fieldPaths(schema));
    const holders = Object.entries(RUNNER_REPLIES).flatMap(([name, schema]) => [...new Set(paths(schema as z.ZodTypeAny).filter((p) => p.split(".").pop() === "token"))].map((p) => `${name}:${p}`));
    // D#6 RUNNER-WAKE R3a: the wake token is minted by the cloud and bound to the runner's own key; it is the same field on every reply that has it.
    expect(holders.sort()).toEqual(["claim:wake.token", "hello:wake.token", "plane_push_token:token"]);
  });
});

describe("the pairing request and reply", () => {
  const fixture = () => ({
    code_repo: "Acme/Widgets-Public",
    overlay_globs: ["docs/ops/", "scripts/private/"],
    identifier_rules_path: null as string | null,
    plan_data_rules_path: "rules/plan-data.json" as string | null,
  });
  // Computed outside this code: printf '%s' '["acme/widgets-public",["docs/ops/","scripts/private/"],null,"rules/plan-data.json"]' | sha256sum
  const FIXED = "3f54f3beefc4adf91ce2ba6b4056d9cb5b80aef192acd87031bf6a258a3d51c3";
  const reply = (over: Record<string, unknown> = {}) => ({ ...fixture(), pairing_digest: FIXED, ...over });

  it("the request is exactly { run_id, lease_generation }, strict, on the constant path", () => {
    expect(PLANE_PUSH_PAIRING_PATH).toBe("/api/runner/plane-push-pairing");
    expect(RUNNER_MESSAGES.plane_push_pairing).toBe(PlanePushPairingMessage);
    expect(PlanePushPairingMessage.safeParse({ run_id: RUN, lease_generation: 1 }).success).toBe(true);
    for (const bad of [{}, { run_id: RUN }, { run_id: RUN, lease_generation: 1, repo: "a/b" }, { run_id: RUN, lease_generation: 1, globs: [] }, { run_id: "x", lease_generation: 1 }]) {
      expect(PlanePushPairingMessage.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the digest of a fixed fixture is the value computed outside the code, case-folds code_repo, and keeps the stored order of the globs", () => {
    const f = fixture();
    expect(pairingDigest({ codeRepo: f.code_repo, overlayGlobs: f.overlay_globs, identifierRulesPath: f.identifier_rules_path, planDataRulesPath: f.plan_data_rules_path })).toBe(FIXED);
    expect(pairingDigest({ codeRepo: "acme/widgets-public", overlayGlobs: f.overlay_globs, identifierRulesPath: null, planDataRulesPath: "rules/plan-data.json" })).toBe(FIXED);
    expect(pairingDigest({ codeRepo: f.code_repo, overlayGlobs: [...f.overlay_globs].reverse(), identifierRulesPath: null, planDataRulesPath: "rules/plan-data.json" })).not.toBe(FIXED);
    expect(pairingDigest({ codeRepo: "acme/widgets-public", overlayGlobs: ["docs/ops/"], identifierRulesPath: null, planDataRulesPath: null })).toBe("0b3654573286a23ed56daef0a50f90a3baee835cae43d146654316cb6d2c8046");
  });

  it("the reply is strict, on the reply table, and parses a matching pairing (a null rule path included)", () => {
    expect(RUNNER_REPLIES.plane_push_pairing).toBe(PlanePushPairingReply);
    expect(nonStrictObjects(PlanePushPairingReply)).toEqual([]);
    expect(g1Violations(PlanePushPairingReply)).toEqual([]);
    expect(PlanePushPairingReply.safeParse(reply()).success).toBe(true);
    const nulls = { code_repo: "acme/widgets-public", overlay_globs: ["docs/ops/"], identifier_rules_path: null, plan_data_rules_path: null };
    expect(PlanePushPairingReply.safeParse({ ...nulls, pairing_digest: "0b3654573286a23ed56daef0a50f90a3baee835cae43d146654316cb6d2c8046" }).success).toBe(true);
  });

  it("refuses an unknown field, no globs, more than 100, a duplicate, and a glob that is absolute, climbs, doubles a slash or has a character outside the set", () => {
    const refuse = (over: Record<string, unknown>, label: string) => expect(PlanePushPairingReply.safeParse(reply(over)).success, label).toBe(false);
    refuse({ extra: 1 }, "unknown field");
    refuse({ overlay_globs: [] }, "no globs");
    refuse({ overlay_globs: Array.from({ length: MAX_PLANE_PUSH_GLOBS + 1 }, (_, i) => `d${i}/`) }, "101 globs");
    refuse({ overlay_globs: ["docs/", "docs/"] }, "duplicate");
    for (const glob of ["/etc/passwd", "../up", "a/../b", "a//b", "a b", "a\\b", "a\"b", "a\nb", "", "x".repeat(201), "é/"]) refuse({ overlay_globs: [glob] }, `glob ${JSON.stringify(glob)}`);
    refuse({ identifier_rules_path: "rules/*.txt" }, "rule path with a glob character");
    refuse({ plan_data_rules_path: "rules/{a,b}.json" }, "rule path with braces");
    refuse({ identifier_rules_path: "../x" }, "rule path that climbs");
    refuse({ code_repo: "not-a-repo" }, "code_repo shape");
    refuse({ code_repo: "acme/.." }, "code_repo dots");
    for (const digest of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), "", null]) refuse({ pairing_digest: digest }, `digest ${String(digest)}`);
    const exactly100 = Array.from({ length: MAX_PLANE_PUSH_GLOBS }, (_, i) => `d${i}/`);
    const f = fixture();
    expect(PlanePushPairingReply.safeParse({ ...f, overlay_globs: exactly100, pairing_digest: pairingDigest({ codeRepo: f.code_repo, overlayGlobs: exactly100, identifierRulesPath: null, planDataRulesPath: f.plan_data_rules_path }) }).success).toBe(true);
  });

  it("refuses a reply whose fields disagree with its digest, with the fixed message (one glob changed, order swapped, a rule path nulled, another repo)", () => {
    const f = fixture();
    const cases: Array<Record<string, unknown>> = [
      { overlay_globs: ["docs/ops/", "scripts/other/"] },
      { overlay_globs: [...f.overlay_globs].reverse() },
      { plan_data_rules_path: null },
      { identifier_rules_path: "rules/ids.txt" },
      { code_repo: "acme/other-public" },
    ];
    for (const over of cases) {
      const parsed = PlanePushPairingReply.safeParse(reply(over));
      expect(parsed.success, JSON.stringify(over)).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.map((i) => i.message)).toEqual(["the pairing does not match its digest"]);
    }
    // Only the letter case of code_repo may differ, as the digest case-folds it.
    expect(PlanePushPairingReply.safeParse(reply({ code_repo: "ACME/WIDGETS-PUBLIC" })).success).toBe(true);
  });
});
