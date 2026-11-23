import { describe, expect, it } from "vitest";
import { HelloMessage, JobSchema, MACHINE_ONBOARDING_MIN_PROTOCOL, MAX_ENVELOPE_INPUT_BYTES, MAX_PRD_BYTES, ProjectDraft, RUNNER_CAPABILITY_FOR_ROLE, SURVEY_CAPABILITY, SURVEY_FAILURE_CODES, SURVEY_FAILURE_REASONS, SURVEY_MAX_RUN_MS, SURVEY_ROLE, SETUP_FAILURE_CODES, SignedJobSchema, TASK_KINDS, jobCarriesPinnedCommit, readSurveyOutput, taskKindOffered, type RunnerOffer } from "../src/index.js";
import { FIXTURE_DRAFTS, MAX_DRAFT, PLAIN_DRAFT, draftRow } from "./helpers/projectDrafts.js";
import { sampleJob } from "./helpers/sampleJob.js";

const SHA = "a".repeat(40);
const parses = (d: unknown) => ProjectDraft.safeParse(d).success;
const with_ = (over: Record<string, unknown>) => ({ ...PLAIN_DRAFT, ...over });
const surveyJob = (over: Record<string, unknown> = {}) => sampleJob({ role: SURVEY_ROLE, task: { kind: "survey", prompt: "p", prompt_sha256: "0".repeat(64) }, review: { head_sha: SHA }, ...over });
const signedParses = (job: unknown): boolean => SignedJobSchema.safeParse({ job, signature: "A".repeat(86) }).success;

describe("ProjectDraft (D#845 ON-10a)", () => {
  it("accepts every fixture draft, and the PRD at the cap shows uncut", () => {
    for (const [name, d] of Object.entries(FIXTURE_DRAFTS)) expect(parses(d), name).toBe(true);
    expect(Buffer.byteLength(MAX_DRAFT.prd_md, "utf8")).toBe(MAX_PRD_BYTES);
    expect(parses(with_({ prd_md: MAX_DRAFT.prd_md + "x" }))).toBe(false);
  });

  it("is strict at every depth: an unknown key or a `keep` anywhere is refused", () => {
    expect(parses({ ...PLAIN_DRAFT, extra: 1 })).toBe(false);
    expect(parses(with_({ roadmap: [{ ...draftRow("A"), keep: true }] }))).toBe(false);
    expect(parses(with_({ roadmap: [{ ...draftRow("A"), note: "x" }] }))).toBe(false);
    expect(parses(with_({ v: 2 }))).toBe(false);
  });

  it("holds the database's row grammar: key, title, summary, size, dependencies, row count", () => {
    for (const bad of ["a", "1A", "A_B", "A".repeat(17), ""]) expect(parses(with_({ roadmap: [draftRow(bad)] })), bad).toBe(false);
    expect(parses(with_({ roadmap: [draftRow("A", [], "")] }))).toBe(false);
    expect(parses(with_({ roadmap: [draftRow("A", [], "x".repeat(121))] }))).toBe(false);
    expect(parses(with_({ roadmap: [draftRow("A", [], "x".repeat(120))] }))).toBe(true);
    expect(parses(with_({ roadmap: [{ ...draftRow("A"), summary: "x".repeat(501) }] }))).toBe(false);
    expect(parses(with_({ roadmap: [{ ...draftRow("A"), size: "XL" }] }))).toBe(false);
    expect(parses(with_({ roadmap: [] }))).toBe(false);
    const rows = (n: number) => Array.from({ length: n }, (_, i) => draftRow(`R${i}`));
    expect(parses(with_({ roadmap: rows(200) }))).toBe(true);
    expect(parses(with_({ roadmap: rows(201) }))).toBe(false);
    const keys = Array.from({ length: 11 }, (_, i) => `D${i}`);
    expect(parses(with_({ roadmap: [...keys.map((k) => draftRow(k)), draftRow("Z", keys.slice(0, 10))] }))).toBe(true);
    expect(parses(with_({ roadmap: [...keys.map((k) => draftRow(k)), draftRow("Z", keys)] }))).toBe(false);
  });

  it("counts characters like the database does: a 120-character title of multi-byte characters is fine", () => {
    expect(parses(with_({ roadmap: [draftRow("A", [], "日".repeat(120))] }))).toBe(true);
    expect(parses(with_({ roadmap: [draftRow("A", [], "😀".repeat(120))] }))).toBe(true);
    expect(parses(with_({ roadmap: [draftRow("A", [], "😀".repeat(121))] }))).toBe(false);
  });

  it("refuses a duplicate key, an unresolved dependency, a self dependency and a cycle", () => {
    expect(parses(with_({ roadmap: [draftRow("A"), draftRow("A")] }))).toBe(false);
    expect(parses(with_({ roadmap: [draftRow("A", ["B"])] }))).toBe(false);
    expect(parses(with_({ roadmap: [draftRow("A", ["A"])] }))).toBe(false);
    expect(parses(with_({ roadmap: [draftRow("A", ["B"]), draftRow("B", ["A"])] }))).toBe(false);
    expect(parses(with_({ roadmap: [draftRow("A", ["C"]), draftRow("B", ["A"]), draftRow("C", ["B"]), draftRow("D")] }))).toBe(false);
    expect(parses(with_({ roadmap: [draftRow("A"), draftRow("B", ["A"]), draftRow("C", ["A", "B"])] }))).toBe(true);
  });

  it("refuses an empty or oversize PRD and control characters, reads CRLF as LF, and refuses a lone surrogate", () => {
    expect(parses(with_({ prd_md: "" }))).toBe(false);
    expect(parses(with_({ prd_md: "a\u0000b" }))).toBe(false);
    expect(parses(with_({ prd_md: "a\u001bb" }))).toBe(false);
    expect(parses(with_({ prd_md: "a\rb" }))).toBe(false);
    expect(parses(with_({ prd_md: "a\tb\nc" }))).toBe(true);
    expect(ProjectDraft.parse(with_({ prd_md: "a\r\nb" })).prd_md).toBe("a\nb");
    expect(parses(with_({ prd_md: "a\ud800b" }))).toBe(false);
    expect(parses(with_({ roadmap: [draftRow("A", [], "a\u0000b")] }))).toBe(false);
    expect(parses(with_({ roadmap: [draftRow("A", [], "two\nlines")] }))).toBe(false);
    expect(parses(with_({ roadmap: [{ ...draftRow("A"), summary: "two\nlines" }] }))).toBe(true);
  });

  it("the serialized draft must fit the envelope cap", () => {
    // 200 rows of 4-byte characters at the grammar's limits come to more than the cap.
    const fat = Array.from({ length: 200 }, (_, i) => ({ row_key: `R${i}`, title: "😀".repeat(120), summary: "😀".repeat(500), size: "L" as const, depends_on: [] as string[] }));
    expect(Buffer.byteLength(JSON.stringify({ v: 1, prd_md: "x", roadmap: fat }), "utf8")).toBeGreaterThan(MAX_ENVELOPE_INPUT_BYTES);
    expect(parses({ v: 1, prd_md: "x", roadmap: fat })).toBe(false);
  });
});

describe("readSurveyOutput", () => {
  it("answers a draft, or one closed reason and nothing of the answer", () => {
    expect(readSurveyOutput(PLAIN_DRAFT)).toEqual({ ok: true, draft: PLAIN_DRAFT });
    expect(readSurveyOutput(undefined)).toEqual({ ok: false, reason: "no_output" });
    expect(readSurveyOutput(null)).toEqual({ ok: false, reason: "no_output" });
    for (const bad of ["text", 4, [1], { ...PLAIN_DRAFT, extra: 1 }, { ...PLAIN_DRAFT, roadmap: "x" }, { ...PLAIN_DRAFT, roadmap: [null] }]) expect(readSurveyOutput(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: "output_invalid" });
    expect(readSurveyOutput({ ...PLAIN_DRAFT, prd_md: "x".repeat(MAX_PRD_BYTES + 1) })).toEqual({ ok: false, reason: "output_too_large" });
  });

  it("redacts the PRD, each title and each summary before it parses", () => {
    const secret = "sk-ant-api03-" + "A".repeat(40);
    const read = readSurveyOutput({ v: 1, prd_md: `key ${secret}`, roadmap: [{ ...draftRow("A"), title: `t ${secret}`, summary: `s ${secret}` }] });
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read)).not.toContain(secret);
    // The redactor is the caller's to choose, and a title it turns into nothing is then refused by the grammar.
    expect(readSurveyOutput(PLAIN_DRAFT, () => "")).toEqual({ ok: false, reason: "output_invalid" });
  });
});

describe("the survey role (D#845 ON-10a)", () => {
  it("is one constant for the capability, one for the role, and closed lists the cloud writes", () => {
    expect(SURVEY_ROLE).toBe("project-surveyor");
    expect(SURVEY_MAX_RUN_MS).toBe(20 * 60_000);
    expect(RUNNER_CAPABILITY_FOR_ROLE[SURVEY_ROLE]).toBe(SURVEY_CAPABILITY);
    expect(jobCarriesPinnedCommit(SURVEY_ROLE)).toBe(true);
    expect([...SURVEY_FAILURE_CODES]).toEqual(["survey_failed", "survey_timeout"]);
    expect([...SURVEY_FAILURE_REASONS]).toEqual(["output_invalid", "output_too_large", "no_output", "workspace_written", "run_failed", "runner_lost", "refused_at_admit", "cancelled", "deadline"]);
    // A runner can never report them: they are not in the progress vocabulary.
    for (const code of SURVEY_FAILURE_CODES) expect(SETUP_FAILURE_CODES as readonly string[]).not.toContain(code);
  });

  it("the role and the survey kind go together, and each side refuses the mix", () => {
    expect(signedParses(surveyJob())).toBe(true);
    expect(JobSchema.safeParse(surveyJob()).success).toBe(true);
    expect(signedParses(sampleJob({ task: { kind: "survey", prompt: "p", prompt_sha256: "0".repeat(64) } }))).toBe(false);
    expect(signedParses(surveyJob({ task: { kind: "implement", prompt: "p", prompt_sha256: "0".repeat(64) } }))).toBe(false);
    for (const kind of TASK_KINDS) if (kind !== "survey") expect(signedParses(surveyJob({ task: { kind, prompt: "p", prompt_sha256: "0".repeat(64) } })), kind).toBe(false);
    // Like every pinned-commit role, the job carries the commit it reads.
    expect(jobCarriesPinnedCommit(SURVEY_ROLE)).toBe(true);
  });

  it("one rule: taskKindOffered(survey) is the role's capability filter, for every hello the cloud accepts", () => {
    const base = { protocol_version: MACHINE_ONBOARDING_MIN_PROTOCOL, facts: undefined };
    const hellos = [21, 22, 25].flatMap((protocol_version) => [[], ["survey_v1"], ["project_setup_v1"], ["survey_v1", "project_setup_v1", "wake_v1"]].map((capabilities) => ({ ...base, protocol_version, capabilities })));
    let accepted = 0;
    for (const h of hellos) {
      const parsed = HelloMessage.safeParse({ ...legacyHello(), protocol_version: h.protocol_version, capabilities: h.capabilities });
      if (!parsed.success) continue;
      accepted++;
      const offer: RunnerOffer = { protocol_version: parsed.data.protocol_version, capabilities: parsed.data.capabilities ?? [] };
      const filter = RUNNER_CAPABILITY_FOR_ROLE[SURVEY_ROLE] === undefined || offer.capabilities.includes(RUNNER_CAPABILITY_FOR_ROLE[SURVEY_ROLE]);
      expect(taskKindOffered("survey", offer), JSON.stringify(h)).toBe(filter);
    }
    expect(accepted).toBe(10);
    // A hello at 21 that lists survey_v1 is refused, so no stored runner can disagree.
    expect(HelloMessage.safeParse({ ...legacyHello(), protocol_version: 21, capabilities: ["survey_v1"] }).success).toBe(false);
    expect(HelloMessage.safeParse({ ...legacyHello(), protocol_version: 22, capabilities: ["survey_v1"] }).success).toBe(true);
  });
});

import { readFileSync } from "node:fs";
function legacyHello(): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL("./fixtures/hello-legacy.json", import.meta.url), "utf8")) as Record<string, unknown>;
}
