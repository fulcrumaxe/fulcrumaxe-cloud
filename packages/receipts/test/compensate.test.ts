import { describe, expect, it } from "vitest";
import { CATALOGUE } from "@fx/decisions";
import {
  COMPENSATE_REASONS,
  COMPENSATION_COPY,
  compensate,
  compensationSentence,
  planReversal,
  type BuildState,
  type CompensateOutcome,
  type CompensatePorts,
  type CompensateSubject,
  type GitPort,
  type PricedReceipt,
  type RebuildPort,
} from "../src/index.js";
import { fakeBuildState, fakeGit, fakeRebuild } from "./fakes.js";

/**
 * D#7 DP7-2d criteria 1, 2 (the port-failure half), 3 and 5, plus the two refusals ruled for the re-run: a build that would reuse the original branch,
 * and a reversal no person asked for. Every port is a strict fake (test/fakes.ts) or a port that fails the test if it is called at all.
 */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const REPO = "acme/widgets";
const SHA = "a".repeat(40);
const MOVED = "b".repeat(40);
const PR = { number: 7, headSha: SHA };
const T0 = Date.UTC(2026, 9, 1, 12);
const now = () => new Date(T0 + 100 * 3_600_000);
const reversible = CATALOGUE.find((e) => e.reversal.availability === "reversible_before_build")!.id;
const notReversible = CATALOGUE.find((e) => e.reversal.availability === "not_reversible")!.id;
const receipt = (decisionType: string): PricedReceipt => ({ decisionType, createdAt: new Date(T0), reversalFreeUntil: new Date(T0 + 3_600_000) });
const subject = (over: Partial<CompensateSubject> = {}): CompensateSubject => ({ accountId: ACCOUNT, workItemId: ITEM, repo: REPO, side: "runner", actor: OWNER, ...over });
const roles = { [`${ACCOUNT}:${OWNER}`]: "owner", [`${ACCOUNT}:${MEMBER}`]: "member" };

/** A port that fails the test when it is touched. */
const untouchable = (): GitPort & RebuildPort => ({
  rerunAfterBuild: () => {
    throw new Error("rerunAfterBuild must not be called");
  },
  openRevertPr: () => {
    throw new Error("openRevertPr must not be called");
  },
  buildAgain: () => {
    throw new Error("buildAgain must not be called");
  },
});
const calls = (p: object) => Object.keys(p);
/** Wraps a port so every call is counted, and any throw is still a throw. */
function counted<T extends object>(port: T): T & { count: number } {
  const c = { count: 0 };
  return new Proxy(port, {
    get(target, key, recv) {
      if (key === "count") return c.count;
      const v = Reflect.get(target, key, recv) as unknown;
      return typeof v === "function" ? (...a: unknown[]) => ((c.count += 1), (v as (...x: unknown[]) => unknown).apply(target, a)) : v;
    },
  }) as T & { count: number };
}

async function run(state: BuildState, decisionType = reversible, over: Partial<CompensateSubject> = {}, world: { stage?: string; live?: boolean; managed?: boolean; head?: string } = {}) {
  const key = `${ACCOUNT}:${ITEM}`;
  const plan = planReversal(receipt(decisionType), await fakeBuildState({ [key]: state }).stateOf(ACCOUNT, ITEM), now);
  const git = fakeGit({ open: state.stage === "built" ? { [`${REPO}#7`]: world.head ?? SHA } : {}, merged: state.stage === "merged" ? [`${REPO}#7`] : [], personManaged: world.managed ? [`${REPO}#7`] : [] });
  const rebuild = fakeRebuild({ roles, stage: world.stage ?? "pr_opened", ...(world.live === undefined ? {} : { live: world.live }) });
  const outcome = await compensate(plan, subject(over), { git, rebuild });
  return { plan, outcome, git, rebuild };
}

describe("compensate: criterion 1, the four build states", () => {
  it("before the build: no GitHub call and no rebuild; done, none_before_build", async () => {
    const { outcome, git, rebuild } = await run({ stage: "not_started", pr: null });
    expect(outcome).toEqual({ kind: "none_before_build", state: "done", reasonCode: null, prNumber: null, runActionId: null });
    expect(git.writes).toEqual([]);
    expect(rebuild.filed).toEqual([]);
  });

  it("after the build: one pull request close and one Build again in the person's name, and nothing else is written to GitHub", async () => {
    const { outcome, git, rebuild } = await run({ stage: "built", pr: PR });
    expect(outcome).toEqual({ kind: "rerun", state: "done", reasonCode: null, prNumber: 7, runActionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(git.writes).toEqual([`close ${REPO}#7`]);
    expect(rebuild.filed).toEqual([{ workItemId: ITEM, userId: OWNER }]);
    // The port has no method that deletes a branch or writes a ref; the real adapter's fake records every request (git-adapter.test.ts).
    expect(calls(git).sort()).toEqual(["openRevertPr", "rerunAfterBuild", "writes"]);
  });

  it("after merge: one revert pull request, and no close and no rebuild", async () => {
    const { outcome, git, rebuild } = await run({ stage: "merged", pr: PR });
    expect(outcome).toEqual({ kind: "revert_pr", state: "done", reasonCode: null, prNumber: 9007, runActionId: null });
    expect(git.writes).toEqual([`revert ${REPO}#7`]);
    expect(rebuild.filed).toEqual([]);
  });

  it.each([
    ["not_started", null],
    ["built", PR],
    ["merged", PR],
  ] as const)("a refused plan (%s) calls no port at all", async (stage, pr) => {
    const plan = planReversal(receipt(notReversible), { stage, pr } as BuildState, now);
    expect(plan.kind).toBe("refused");
    const ports = counted(untouchable());
    const outcome = await compensate(plan, subject(), { git: ports, rebuild: ports });
    expect(outcome).toEqual({ kind: "refused", state: "done", reasonCode: "not_reversible", prNumber: null, runActionId: null });
    expect(ports.count).toBe(0);
  });

  it("compensating work (a published notice) calls no port and is recorded as unavailable", async () => {
    const ports = counted(untouchable());
    const outcome = await compensate({ kind: "compensating_work" }, subject(), { git: ports, rebuild: ports });
    expect(outcome).toEqual({ kind: "unavailable", state: "done", reasonCode: "retraction_unavailable", prNumber: null, runActionId: null });
    expect(ports.count).toBe(0);
  });

  it("while building with no pull request yet, nothing is closed and the rebuild is asked, which refuses while the run is live", async () => {
    const { outcome, git, rebuild } = await run({ stage: "building", pr: null }, reversible, {}, { stage: "in_progress", live: true });
    expect(outcome).toEqual({ kind: "rerun", state: "failed", reasonCode: "rerun_refused", prNumber: null, runActionId: null });
    expect(git.writes).toEqual([]);
    expect(rebuild.filed).toEqual([]);
  });
});

const OWN_BRANCH = { scheme: 1, identityResolved: true } as const;

describe("compensate: the re-run, and when a cloud item is refused (C27 R4)", () => {
  const plan = () => planReversal(receipt(reversible), { stage: "built", pr: PR }, now);

  it.each([
    ["no scheme in the running deployment (absent)", undefined],
    ["a scheme of null", { scheme: null, identityResolved: true }],
    ["a scheme of 0", { scheme: 0, identityResolved: true }],
    ["a child whose build identity does not resolve", { scheme: 1, identityResolved: false }],
  ] as const)("a cloud item with %s is refused with rerun_would_overwrite_branch before any port is called", async (_label, rerunBranch) => {
    const ports = counted(untouchable());
    const over = rerunBranch === undefined ? subject({ side: "cloud" }) : subject({ side: "cloud", rerunBranch });
    expect(await compensate(plan(), over, { git: ports, rebuild: ports })).toEqual({ kind: "rerun", state: "failed", reasonCode: "rerun_would_overwrite_branch", prNumber: 7, runActionId: null });
    expect(ports.count).toBe(0);
  });

  /** One shared log, so the order of the two ports' calls across them is shown. */
  function ordered() {
    const log: string[] = [];
    const inner = fakeGit({ open: { [`${REPO}#7`]: SHA }, merged: [] });
    const rebuild = fakeRebuild({ roles, stage: "pr_opened" });
    const ports: CompensatePorts = {
      git: {
        rerunAfterBuild: async (i) => (log.push(`rerunAfterBuild ${i.repo}#${i.number}@${i.headSha === SHA ? "recorded-head" : i.headSha}`), inner.rerunAfterBuild(i)),
        openRevertPr: async (i) => (log.push("openRevertPr"), inner.openRevertPr(i)),
      },
      rebuild: { buildAgain: async (i) => (log.push(`buildAgain ${i.userId === OWNER ? "person" : i.userId}`), rebuild.buildAgain(i)) },
    };
    return { log, ports, rebuild };
  }

  // A paired item is the same side for compensate (its public branch is not a per-run branch and is not read here), so both kinds must give the same answer.
  const rows = (["runner", "cloud"] as const).flatMap((side) =>
    (["sandbox", "paired sandbox"] as const).flatMap((kind) =>
      (["top-level", "child"] as const).flatMap((item) =>
        ([OWNER, "policy"] as const).flatMap((actor) =>
          (["present", "scheme_absent", "identity_unresolved"] as const).filter((how) => item === "child" || how !== "identity_unresolved").map((how) => ({ side, kind, item, actor, how })),
        ),
      ),
    ),
  );

  it("the table has every cell: 2 sides x 2 kinds x (top-level 2 actors x 2 build paths + child 2 actors x 3)", () => {
    expect(rows).toHaveLength(2 * 2 * (4 + 6));
  });

  it.each(rows)("side $side, kind $kind, item $item, actor $actor, build path $how", async ({ side, actor, how }) => {
    const { log, ports, rebuild } = ordered();
    const rerunBranch = how === "present" ? OWN_BRANCH : how === "scheme_absent" ? { scheme: null, identityResolved: true } : { scheme: 1, identityResolved: false };
    const outcome = await compensate(plan(), subject({ side, actor, rerunBranch }), ports);
    if (side === "cloud" && how !== "present") {
      expect(outcome).toMatchObject({ state: "failed", reasonCode: "rerun_would_overwrite_branch" });
      expect(log).toEqual([]);
    } else if (actor === "policy") {
      expect(outcome).toMatchObject({ state: "failed", reasonCode: "no_person_actor" });
      expect(log).toEqual([]);
    } else {
      expect(outcome).toMatchObject({ kind: "rerun", state: "done", reasonCode: null, prNumber: 7 });
      expect(log).toEqual([`rerunAfterBuild ${REPO}#7@recorded-head`, "buildAgain person"]);
      expect(rebuild.filed).toEqual([{ workItemId: ITEM, userId: OWNER }]);
    }
  });

  it("a cloud item with its own branch goes ahead: the pull request is closed at its recorded head, then Build again is filed", async () => {
    const { outcome, git, rebuild } = await run({ stage: "built", pr: PR }, reversible, { side: "cloud", rerunBranch: OWN_BRANCH });
    expect(outcome).toMatchObject({ kind: "rerun", state: "done" });
    expect(git.writes).toEqual([`close ${REPO}#7`]);
    expect(rebuild.filed).toEqual([{ workItemId: ITEM, userId: OWNER }]);
  });

  it("a runner item with the same plan goes ahead", async () => {
    const { outcome, git } = await run({ stage: "built", pr: PR }, reversible, { side: "runner" });
    expect(outcome.state).toBe("done");
    expect(git.writes).toEqual([`close ${REPO}#7`]);
  });

  it.each(["policy", "", "not-a-user"])("a reversal whose actor is %j files nothing in the orchestrator's name: no_person_actor, no port called", async (actor) => {
    const plan = planReversal(receipt(reversible), { stage: "built", pr: PR }, now);
    const ports = counted(untouchable());
    expect(await compensate(plan, subject({ actor }), { git: ports, rebuild: ports })).toEqual({ kind: "rerun", state: "failed", reasonCode: "no_person_actor", prNumber: 7, runActionId: null });
    expect(ports.count).toBe(0);
  });

  it("a member who is not an owner or admin is refused by the rebuild table: rerun_refused, and nothing is filed", async () => {
    const { outcome, rebuild } = await run({ stage: "built", pr: PR }, reversible, { actor: MEMBER });
    expect(outcome).toMatchObject({ kind: "rerun", state: "failed", reasonCode: "rerun_refused" });
    expect(rebuild.filed).toEqual([]);
  });

  it("an item that moved past where a rebuild starts is state_changed", async () => {
    const { outcome } = await run({ stage: "built", pr: PR }, reversible, {}, { stage: "merged" });
    expect(outcome).toMatchObject({ kind: "rerun", state: "failed", reasonCode: "state_changed" });
  });

  it("a revert after merge does not need a person to file anything, so a policy reversal still opens it", async () => {
    const { outcome } = await run({ stage: "merged", pr: PR }, reversible, { actor: "policy", side: "cloud" });
    expect(outcome).toMatchObject({ kind: "revert_pr", state: "done" });
  });
});

describe("compensate: criterion 3, a head that moved or a person's takeover is left", () => {
  it("a head that moved ends failed with head_moved; nothing is closed and nothing is rebuilt", async () => {
    const { outcome, git, rebuild } = await run({ stage: "built", pr: PR }, reversible, {}, { head: MOVED });
    expect(outcome).toEqual({ kind: "rerun", state: "failed", reasonCode: "head_moved", prNumber: 7, runActionId: null });
    expect(git.writes).toEqual([]);
    expect(rebuild.filed).toEqual([]);
  });

  it("a person's takeover ends failed with person_managed; nothing is closed and nothing is rebuilt", async () => {
    const { outcome, git, rebuild } = await run({ stage: "built", pr: PR }, reversible, {}, { managed: true });
    expect(outcome).toEqual({ kind: "rerun", state: "failed", reasonCode: "person_managed", prNumber: 7, runActionId: null });
    expect(git.writes).toEqual([]);
    expect(rebuild.filed).toEqual([]);
  });
});

describe("compensate: criterion 2, a port failure is a fixed code and never a throw", () => {
  const rerun = planReversal(receipt(reversible), { stage: "built", pr: PR }, now);
  const revert = planReversal(receipt(reversible), { stage: "merged", pr: PR }, now);
  const rebuildOk = fakeRebuild({ roles, stage: "pr_opened" });
  const failing = (how: "throw" | "unavailable"): GitPort => ({
    rerunAfterBuild: async () => {
      if (how === "throw") throw new Error("connect ECONNREFUSED 10.0.0.1:443 token ghs_secret");
      return { ok: false, code: "unavailable" };
    },
    openRevertPr: async () => {
      if (how === "throw") throw new Error("connect ECONNREFUSED 10.0.0.1:443 token ghs_secret");
      return { ok: false, code: "unavailable" };
    },
  });

  it.each(["throw", "unavailable"] as const)("a GitPort that answers %s leaves the re-run and the revert failed with tooling_error, and keeps no error text", async (how) => {
    const a = await compensate(rerun, subject(), { git: failing(how), rebuild: rebuildOk });
    const b = await compensate(revert, subject(), { git: failing(how), rebuild: rebuildOk });
    expect(a).toEqual({ kind: "rerun", state: "failed", reasonCode: "tooling_error", prNumber: 7, runActionId: null });
    expect(b).toEqual({ kind: "revert_pr", state: "failed", reasonCode: "tooling_error", prNumber: null, runActionId: null });
    expect(JSON.stringify([a, b])).not.toMatch(/ECONNREFUSED|ghs_|10\.0\.0\.1/);
  });

  it("a revert GitHub refuses (a conflict) is failed with revert_refused; a pull request that is not merged after all is state_changed", async () => {
    const conflict = fakeGit({ open: {}, merged: [`${REPO}#7`], conflicts: [`${REPO}#7`] });
    expect(await compensate(revert, subject(), { git: conflict, rebuild: rebuildOk })).toMatchObject({ state: "failed", reasonCode: "revert_refused" });
    expect(await compensate(revert, subject(), { git: fakeGit({ open: {}, merged: [] }), rebuild: rebuildOk })).toMatchObject({ state: "failed", reasonCode: "state_changed" });
  });

  it("a rebuild that throws after the close is failed with tooling_error", async () => {
    const git = fakeGit({ open: { [`${REPO}#7`]: SHA }, merged: [] });
    const out = await compensate(rerun, subject(), { git, rebuild: { buildAgain: () => Promise.reject(new Error("db down")) } });
    expect(out).toEqual({ kind: "rerun", state: "failed", reasonCode: "tooling_error", prNumber: 7, runActionId: null });
  });

  it("a pull request that is no longer open is state_changed, and no rebuild is filed", async () => {
    const rebuild = fakeRebuild({ roles, stage: "pr_opened" });
    expect(await compensate(rerun, subject(), { git: fakeGit({ open: {}, merged: [] }), rebuild })).toMatchObject({ state: "failed", reasonCode: "state_changed" });
    expect(rebuild.filed).toEqual([]);
  });

  it("a failure is not final: the next attempt on the same plan, once GitHub answers, is done", async () => {
    expect((await compensate(revert, subject(), { git: failing("throw"), rebuild: rebuildOk })).state).toBe("failed");
    expect((await compensate(revert, subject(), { git: fakeGit({ open: {}, merged: [`${REPO}#7`] }), rebuild: rebuildOk })).state).toBe("done");
  });
});

describe("compensate: criterion 5, the copy (R-S1-3)", () => {
  const strings = [COMPENSATION_COPY.none_before_build, COMPENSATION_COPY.rerun, COMPENSATION_COPY.revert_pr, COMPENSATION_COPY.refused, COMPENSATION_COPY.unavailable, ...Object.values(COMPENSATION_COPY.failed)];

  it("after a merge, the done sentence says we opened a revert for you to review", () => {
    const done: CompensateOutcome = { kind: "revert_pr", state: "done", reasonCode: null, prNumber: 9007, runActionId: null };
    expect(compensationSentence(done)).toMatch(/^We opened a revert for you to review\./);
  });

  it("no sentence anywhere says the change was undone by us", () => {
    for (const s of strings) expect(s).not.toMatch(/\bund(?:id|one|o)\b|rolled back|roll(?:ed)? it back|reverted (?:it|the|your)|we reverted/i);
  });

  it("every outcome the compensation can produce has a sentence: never empty, null or undefined", () => {
    const kinds = ["none_before_build", "rerun", "revert_pr", "refused", "unavailable"] as const;
    for (const kind of kinds) {
      for (const state of ["done", "failed"] as const) {
        for (const reasonCode of [null, ...COMPENSATE_REASONS]) {
          const s = compensationSentence({ kind, state, reasonCode });
          expect(typeof s).toBe("string");
          expect(s.trim().length).toBeGreaterThan(10);
          expect(s).not.toMatch(/null|undefined|\[object/);
        }
      }
    }
    expect(Object.keys(COMPENSATION_COPY.failed).sort()).toEqual([...COMPENSATE_REASONS].sort());
  });

  it("each failed reason reads differently, so a person can tell them apart", () => {
    const failed = Object.entries(COMPENSATION_COPY.failed).filter(([k]) => k !== "not_reversible" && k !== "retraction_unavailable");
    expect(new Set(failed.map(([, v]) => v)).size).toBe(failed.length);
  });
});
