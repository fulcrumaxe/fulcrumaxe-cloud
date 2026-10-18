import { describe, expect, it } from "vitest";
import { PLANE_PUSH_PAIRING_PATH, PLANE_PUSH_REPORT_PATH, PLANE_PUSH_TOKEN_PATH, PlanePushPairingMessage, PlanePushReportMessage, PlanePushTokenMessage } from "@fulcrumaxe/runner-protocol";
import { pairingDigest } from "@fulcrumaxe/runner-protocol/pairingDigest";
import { createRunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey } from "../../src/keys.js";

/** D#598 P1f-3: the three signed calls of the run-end hook, with the replies the cloud's routes give (runner-cloud/src/planePush.ts). */
const RUN = "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f";
const TOKEN = ["ghs", "clienttestvalue0000001"].join("_");
const PAIRING = { codeRepo: "acme/widgets", overlayGlobs: ["docs/ops/", "rules/"], identifierRulesPath: "rules/ids.txt", planDataRulesPath: null as string | null };
const pairingBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  code_repo: PAIRING.codeRepo, overlay_globs: PAIRING.overlayGlobs, identifier_rules_path: PAIRING.identifierRulesPath, plan_data_rules_path: PAIRING.planDataRulesPath, pairing_digest: pairingDigest(PAIRING), ...over,
});
const tokenBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  token: TOKEN, expires_at: "2026-10-17T12:00:00.000Z", code_repo: "acme/widgets", branch: "fx/p-11111111-2222-4333-8444-555555555555", base: "main",
  pr: { title: "Change from fulcrumaxe run 0b1b6c52", body: "Opened by a fulcrumaxe run." }, identity: { name: "Fulcrumaxe Bot", email: "bot@example.test" }, ...over,
});
const errorBody = (code: string): unknown => ({ error: { code, message: "x" } });

function clientAnswering(status: number, body: unknown) {
  const seen: Array<{ url: string; body: string }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), body: String(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { client: createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn }), seen };
}
const STOP = { continue: false, reason: "stale_generation" };

describe("the signed plane-push-pairing call", () => {
  it("sends only the run and the generation to the constant path and returns the pairing the reply gave", async () => {
    const { client, seen } = clientAnswering(200, pairingBody());
    const got = await client.planePushPairing(RUN, 2);
    expect(got).toMatchObject({ kind: "pairing", pairing: { code_repo: "acme/widgets", overlay_globs: ["docs/ops/", "rules/"], plan_data_rules_path: null } });
    expect(seen[0]!.url).toBe(`https://cloud.example.test${PLANE_PUSH_PAIRING_PATH}`);
    expect(PlanePushPairingMessage.parse(JSON.parse(seen[0]!.body))).toEqual({ run_id: RUN, lease_generation: 2 });
  });

  it("a reply that disagrees with its own digest is an invalid reply, whichever field moved", async () => {
    for (const over of [{ overlay_globs: ["rules/", "docs/ops/"] }, { overlay_globs: ["docs/ops/"] }, { identifier_rules_path: null }, { code_repo: "acme/other" }, { plan_data_rules_path: "rules/plan.json" }]) {
      expect(await clientAnswering(200, pairingBody(over)).client.planePushPairing(RUN, 1), JSON.stringify(over)).toMatchObject({ kind: "error", status: 200, code: "invalid_reply" });
    }
    expect(await clientAnswering(200, pairingBody({ extra: 1 })).client.planePushPairing(RUN, 1)).toMatchObject({ code: "invalid_reply" });
  });

  it("maps 403 not_paired, 409 pairing_changed and a stop reply, and keeps any other status", async () => {
    expect(await clientAnswering(403, errorBody("not_paired")).client.planePushPairing(RUN, 1)).toEqual({ kind: "not_paired" });
    expect(await clientAnswering(409, errorBody("pairing_changed")).client.planePushPairing(RUN, 1)).toEqual({ kind: "pairing_changed" });
    expect(await clientAnswering(409, STOP).client.planePushPairing(RUN, 1)).toEqual({ kind: "stop", reason: "stale_generation" });
    expect(await clientAnswering(503, errorBody("not_configured")).client.planePushPairing(RUN, 1)).toMatchObject({ kind: "error", status: 503, code: "not_configured" });
    expect(await clientAnswering(403, errorBody("forbidden")).client.planePushPairing(RUN, 1)).toMatchObject({ kind: "error", status: 403 });
  });
});

describe("the signed plane-push-token call", () => {
  it("sends only the run and the generation and returns the reply, with the text and the identity", async () => {
    const { client, seen } = clientAnswering(200, tokenBody());
    const got = await client.planePushToken(RUN, 1);
    expect(got).toMatchObject({ kind: "token", reply: { token: TOKEN, code_repo: "acme/widgets", pr: { title: "Change from fulcrumaxe run 0b1b6c52" }, identity: { name: "Fulcrumaxe Bot" } } });
    expect(seen[0]!.url).toBe(`https://cloud.example.test${PLANE_PUSH_TOKEN_PATH}`);
    expect(PlanePushTokenMessage.parse(JSON.parse(seen[0]!.body))).toEqual({ run_id: RUN, lease_generation: 1 });
  });

  it("a reply without the text or the identity, or with an extra field, is an invalid reply", async () => {
    for (const body of [{ ...tokenBody(), pr: undefined }, { ...tokenBody(), identity: undefined }, tokenBody({ extra: 1 }), tokenBody({ branch: "main" }), tokenBody({ base: "develop" })]) {
      expect(await clientAnswering(200, body).client.planePushToken(RUN, 1)).toMatchObject({ kind: "error", code: "invalid_reply" });
    }
  });

  it("maps not_paired, the closed refusal words, and a stop reply; any other word keeps its status", async () => {
    expect(await clientAnswering(403, errorBody("not_paired")).client.planePushToken(RUN, 1)).toEqual({ kind: "not_paired" });
    for (const [status, code] of [[409, "pairing_changed"], [409, "already_issued"], [409, "attempts_exhausted"], [409, "app_not_installed"], [502, "token_scope_mismatch"], [503, "public_unavailable"], [503, "not_configured"]] as const) {
      expect(await clientAnswering(status, errorBody(code)).client.planePushToken(RUN, 1), code).toEqual({ kind: "refused", code });
    }
    expect(await clientAnswering(409, STOP).client.planePushToken(RUN, 1)).toEqual({ kind: "stop", reason: "stale_generation" });
    expect(await clientAnswering(400, errorBody("invalid_message")).client.planePushToken(RUN, 1)).toMatchObject({ kind: "error", status: 400, code: "invalid_message" });
    expect(await clientAnswering(500, errorBody("already_issued")).client.planePushToken(RUN, 1)).toMatchObject({ kind: "error", status: 500 });
  });
});

describe("the signed plane-push-report call", () => {
  const message = { run_id: RUN, lease_generation: 1, phase: "refused" as const, code: "scan_refused", refusals: [{ kind: "identifier_hit", place: "src/a.ts:2", rule_key: "identifier-rule#1" }] };

  it("sends the report to the constant path and says only that it was recorded", async () => {
    const { client, seen } = clientAnswering(200, { recorded: true });
    expect(await client.planePushReport(message)).toEqual({ kind: "recorded" });
    expect(seen[0]!.url).toBe(`https://cloud.example.test${PLANE_PUSH_REPORT_PATH}`);
    expect(PlanePushReportMessage.parse(JSON.parse(seen[0]!.body))).toEqual(message);
  });

  it("refuses a message the protocol does not describe before it is sent, and a phase that needs the digest without it", async () => {
    const { client, seen } = clientAnswering(200, { recorded: true });
    expect(await client.planePushReport({ ...message, content: "x" } as never)).toMatchObject({ kind: "error", status: 0, code: "invalid_message" });
    expect(await client.planePushReport({ run_id: RUN, lease_generation: 1, phase: "pr_opened", branch: "fx/p-x", head_sha: "a".repeat(40), tip_sha: "b".repeat(40), pr_number: 3 })).toMatchObject({ code: "invalid_message" });
    expect(seen).toEqual([]);
  });

  it("maps not_paired and a stop reply, and keeps any other status", async () => {
    expect(await clientAnswering(403, errorBody("not_paired")).client.planePushReport(message)).toEqual({ kind: "not_paired" });
    expect(await clientAnswering(409, STOP).client.planePushReport(message)).toEqual({ kind: "stop", reason: "stale_generation" });
    expect(await clientAnswering(503, errorBody("public_unavailable")).client.planePushReport(message)).toMatchObject({ kind: "error", status: 503 });
    expect(await clientAnswering(200, { recorded: false }).client.planePushReport(message)).toMatchObject({ code: "invalid_reply" });
  });
});
