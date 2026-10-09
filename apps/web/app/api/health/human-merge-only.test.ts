import { describe, expect, it } from "vitest";
import { HUMAN_MERGE_ONLY_ENV, HUMAN_MERGE_ONLY_INVALID_CODE, parseHumanMergeOnlyIds } from "@fx/db/src/humanMergeOnly";
import { ENV_MANIFEST } from "../../../env-manifest";
import { validateValue } from "../../../lib/env/check";
import { completeEnv } from "../../../test/support/envFixtures";
import { healthResponse } from "./handler";

/**
 * D#6 M1G-a: the settings check for FX_HUMAN_MERGE_ONLY_REPO_IDS. The manifest lists it, /api/health reports a malformed
 * value as `human_merge_only_config_invalid` (name and fixed code, never the value) to an operator, and fails the verdict in
 * every deploy kind, because the merge gate is then locking every repository.
 */
const OPERATOR_TOKEN = "c".repeat(40);
type Env = Record<string, string | undefined>;
const ask = async (env: Env, auth: string | null = null) => {
  const res = healthResponse(env, auth);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("the manifest entry", () => {
  const entry = ENV_MANIFEST.find((e) => e.name === HUMAN_MERGE_ONLY_ENV);
  it("is listed, optional everywhere, not secret, and says what a malformed value does", () => {
    expect(entry).toBeDefined();
    expect(entry!.requiredIn).toEqual([]);
    expect(entry!.secret).toBe(false);
    expect(entry!.note).toContain("fail closed");
  });

  it("its validation and the runtime parser agree on every value (one definition of 'malformed')", () => {
    for (const v of ["1", "123,456", "1131052000", "abc", "1,,2", " 1", "-1", "1,", "0", "01", "1, 2", "1.5", "9007199254740993"]) {
      const ok = validateValue({ type: "repo-id-list" }, v) === null;
      expect(ok, JSON.stringify(v)).toBe(parseHumanMergeOnlyIds(v).kind === "ok");
    }
    expect(validateValue({ type: "repo-id-list" }, "abc")).toBe(HUMAN_MERGE_ONLY_INVALID_CODE);
  });
});

describe("GET /api/health and the human-merge-only list", () => {
  it("unset, empty and a valid list leave the verdict alone", async () => {
    for (const v of [undefined, "", "123,456"]) {
      expect((await ask({ ...completeEnv("production"), [HUMAN_MERGE_ONLY_ENV]: v })).status, String(v)).toBe(200);
    }
  });

  it("a malformed list is a 503 in every deploy kind; an operator sees the setting name and the fixed code, and never the value", async () => {
    for (const kind of ["local", "staging", "production"] as const) {
      for (const bad of ["abc", "1,,2", "-1"]) {
        const env = { ...completeEnv(kind), CRON_SECRET: OPERATOR_TOKEN, [HUMAN_MERGE_ONLY_ENV]: bad };
        const anon = await ask(env);
        expect(anon.status, `${kind} ${bad}`).toBe(503);
        expect(JSON.stringify(anon.body)).not.toContain(HUMAN_MERGE_ONLY_ENV);
        const op = await ask(env, `Bearer ${OPERATOR_TOKEN}`);
        expect(op.body.invalid).toContainEqual({ name: HUMAN_MERGE_ONLY_ENV, reason: HUMAN_MERGE_ONLY_INVALID_CODE });
        expect(op.body.invalid_optional).not.toContainEqual(expect.objectContaining({ name: HUMAN_MERGE_ONLY_ENV }));
        expect(JSON.stringify(op.body)).not.toContain(`"${bad}"`);
      }
    }
  });
});
