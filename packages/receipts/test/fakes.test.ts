import { describe, expect, it } from "vitest";
import { unavailableRetractionPort } from "../src/ports.js";
import { fakeBuildState, fakeGit, fakeLedger, fakeRetraction } from "./fakes.js";

/**
 * D#7 DP7-2b criterion 6: each fake rejects a call its real counterpart would reject. The shapes, by fake:
 *  - ledger: an id that is not a UUID; a stored amount that is negative or not finite.
 *  - build state: an id that is not a UUID; an item of another account; a built or merged item with no pull request; a not-started item with one.
 *  - git: a repo that is not owner/name; a number that is not a positive integer; a head sha that is not 40 hex characters; closing a pull
 *    request that is not open or whose head moved; reverting one that is not merged; a revert GitHub refuses. No method deletes a branch.
 *  - retraction: an unknown surface; an empty ref. The shipped default answers `unavailable` and writes nothing.
 */
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const W = "33333333-3333-4333-8333-333333333333";
const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);

describe("fakeLedger", () => {
  it("answers the stored spend, zero for an item with none, and records each read", async () => {
    const l = fakeLedger({ [`${A}:${W}`]: 1.5 });
    expect(await l.workItemBuildSpendUsd(A, W)).toBe(1.5);
    expect(await l.workItemBuildSpendUsd(B, W)).toBe(0);
    expect(l.reads).toEqual([[A, W], [B, W]]);
  });
  it("rejects a malformed id and a stored amount that is negative or not finite", async () => {
    await expect(fakeLedger().workItemBuildSpendUsd("nope", W)).rejects.toThrow(TypeError);
    await expect(fakeLedger().workItemBuildSpendUsd(A, "nope")).rejects.toThrow(TypeError);
    await expect(fakeLedger({ [`${A}:${W}`]: -1 }).workItemBuildSpendUsd(A, W)).rejects.toThrow(RangeError);
    await expect(fakeLedger({ [`${A}:${W}`]: Number.NaN }).workItemBuildSpendUsd(A, W)).rejects.toThrow(RangeError);
  });
});

describe("fakeBuildState", () => {
  const pr = { number: 7, headSha: SHA1 };
  const port = fakeBuildState({
    [`${A}:${W}`]: { stage: "built", pr },
    [`${A}:${B}`]: { stage: "not_started", pr: null },
    [`${B}:${W}`]: { stage: "merged", pr: null },
    [`${B}:${A}`]: { stage: "not_started", pr },
  });
  it("answers a known item", async () => {
    expect(await port.stateOf(A, W)).toEqual({ stage: "built", pr });
    expect(await port.stateOf(A, B)).toEqual({ stage: "not_started", pr: null });
  });
  it("rejects a malformed id, an item of another account, and a stage that does not match its pull request", async () => {
    await expect(port.stateOf("nope", W)).rejects.toThrow(TypeError);
    await expect(port.stateOf(B, B)).rejects.toThrow("not found");
    await expect(port.stateOf(B, W)).rejects.toThrow("must carry its pull request");
    await expect(port.stateOf(B, A)).rejects.toThrow("has no pull request");
  });
});

describe("fakeGit", () => {
  const repo = "acme/widgets";
  const fresh = () => fakeGit({ open: { [`${repo}#5`]: SHA1 }, merged: [`${repo}#6`, `${repo}#8`], conflicts: [`${repo}#8`] });

  it("closes the open pull request at exactly the recorded head, once", async () => {
    const g = fresh();
    expect(await g.rerunAfterBuild({ repo, number: 5, headSha: SHA1 })).toEqual({ ok: true, closed: true });
    expect(await g.rerunAfterBuild({ repo, number: 5, headSha: SHA1 })).toEqual({ ok: false, code: "not_open" });
    expect(g.writes).toEqual([`close ${repo}#5`]);
  });
  it("refuses a head that moved and writes nothing", async () => {
    const g = fresh();
    expect(await g.rerunAfterBuild({ repo, number: 5, headSha: SHA2 })).toEqual({ ok: false, code: "stale_head" });
    expect(g.writes).toEqual([]);
  });
  it("leaves a pull request a person took over, at any head, and writes nothing", async () => {
    const g = fakeGit({ open: { [`${repo}#5`]: SHA1 }, merged: [], personManaged: [`${repo}#5`] });
    expect(await g.rerunAfterBuild({ repo, number: 5, headSha: SHA1 })).toEqual({ ok: false, code: "person_managed" });
    expect(await g.rerunAfterBuild({ repo, number: 5, headSha: SHA2 })).toEqual({ ok: false, code: "person_managed" });
    expect(g.writes).toEqual([]);
  });
  it("opens a revert only for a merged pull request, and relays a refusal as a fixed code", async () => {
    const g = fresh();
    expect(await g.openRevertPr({ repo, number: 5 })).toEqual({ ok: false, code: "not_merged" });
    expect(await g.openRevertPr({ repo, number: 8 })).toEqual({ ok: false, code: "revert_refused" });
    expect(await g.openRevertPr({ repo, number: 6 })).toEqual({ ok: true, number: 9006 });
    expect(g.writes).toEqual([`revert ${repo}#6`]);
  });
  it("rejects a malformed repo, number or sha", async () => {
    const g = fresh();
    await expect(g.openRevertPr({ repo: "widgets", number: 6 })).rejects.toThrow(TypeError);
    await expect(g.openRevertPr({ repo, number: 0 })).rejects.toThrow(TypeError);
    await expect(g.openRevertPr({ repo, number: 1.5 })).rejects.toThrow(TypeError);
    await expect(g.rerunAfterBuild({ repo, number: 5, headSha: "abc" })).rejects.toThrow(TypeError);
  });
  it("has no method that deletes a branch", () => {
    expect(Object.keys(fresh()).sort()).toEqual(["openRevertPr", "rerunAfterBuild", "writes"]);
  });
});

describe("retraction", () => {
  it("the shipped default answers unavailable for every call", async () => {
    expect(await unavailableRetractionPort.retractDeprecationNotice({ surface: "release", ref: "v1" })).toEqual({ ok: false, code: "unavailable" });
    expect(await unavailableRetractionPort.retractDeprecationNotice({ surface: "discussion", ref: "d" })).toEqual({ ok: false, code: "unavailable" });
  });
  it("the fake rejects an unknown surface and an empty ref", async () => {
    const r = fakeRetraction();
    await expect(r.retractDeprecationNotice({ surface: "blog" as never, ref: "x" })).rejects.toThrow(TypeError);
    await expect(r.retractDeprecationNotice({ surface: "release", ref: "" })).rejects.toThrow(TypeError);
    expect(await r.retractDeprecationNotice({ surface: "release", ref: "v1" })).toEqual({ ok: true, retracted: true });
    expect(r.writes).toEqual(["release:v1"]);
  });
});
