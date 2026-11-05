import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryProposalsMessage } from "@fulcrumaxe/runner-protocol";
import type { MemoryProposalsResult } from "../src/daemon/client.js";
import { OFFER_COPY, createMemoryOffer, questionFor, readProposals, readProposalsCounted, type MemoryOfferDeps } from "../src/memoryOffer.js";

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const RUN = randomUUID();
const ONE = "run the unit tests with pnpm test, not npm";
const TWO = "the config lives in config/app.toml";
const THREE = "never commit the generated client";
const proposal = (body: string, over: Record<string, unknown> = {}) => ({ scope: "repo", kind: "command", body, ...over });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxr-memoffer-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A person at a terminal who answers in order, and a cloud that records what it is sent. */
function rig(over: Partial<MemoryOfferDeps> & { answers?: Array<string | undefined>; result?: MemoryProposalsResult; beforeAnswer?: (n: number) => void } = {}) {
  const asked: string[] = [];
  const said: string[] = [];
  const sent: MemoryProposalsMessage[] = [];
  const answers = [...(over.answers ?? [])];
  const offer = createMemoryOffer({
    stateDir: dir,
    enabled: () => true,
    interactive: true,
    ask: async (question) => {
      asked.push(question);
      over.beforeAnswer?.(asked.length);
      return answers.shift();
    },
    say: (line) => said.push(line),
    send: async (message) => {
      sent.push(message);
      return over.result ?? { kind: "sent", status: "ingested", stored: message.proposals.length, refused: 0 };
    },
    ...over,
  });
  return { offer, asked, said, sent };
}
const record = () => JSON.parse(readFileSync(path.join(dir, `memory-offer-${RUN}.json`), "utf8")) as { run_id: string; proposals: Array<{ scope: string; body: string; sha256: string; state: string }> };

describe("the strict reader", () => {
  it("keeps scope, kind and body from closed sets, and drops every other key, so a reason or a role is never shown or sent", () => {
    const [kept] = readProposals([proposal(ONE, { why: "because", role: "executor", path: "/etc/passwd", transcript: "x" })]);
    expect(kept).toEqual({ scope: "repo", kind: "command", body: ONE, sha256: sha(ONE) });
    expect(Object.keys(kept!).sort()).toEqual(["body", "kind", "scope", "sha256"]);
  });

  it("a body that appears twice is one proposal, the first, whatever the second one's scope or kind", () => {
    expect(readProposals([proposal(ONE, { scope: "repo", kind: "command" }), proposal(ONE, { scope: "item", kind: "gotcha" }), proposal(TWO)]).map((p) => [p.scope, p.kind, p.body])).toEqual([["repo", "command", ONE], ["repo", "command", TWO]]);
  });

  it("takes at most three, and only items that pass: an unknown scope or kind, the account scope, a non-string body, a body of 0 or over 1024 bytes", () => {
    expect(readProposals([proposal(ONE), proposal(TWO), proposal(THREE), proposal("a fourth")])).toHaveLength(3);
    const bad = [proposal(ONE, { scope: "account" }), proposal(ONE, { scope: "everything" }), proposal(ONE, { kind: "rule" }), proposal(""), proposal("a".repeat(1025)), proposal(5 as never), null, "text", [], { scope: "repo" }];
    expect(readProposals(bad)).toEqual([]);
    expect(readProposals("not an array")).toEqual([]);
    expect(readProposals({ 0: proposal(ONE) })).toEqual([]);
    expect(readProposals(undefined)).toEqual([]);
  });

  it("refuses a body that could move the cursor or fake a prompt: escape sequences, newlines, carriage returns, bidi and zero-width characters", () => {
    for (const body of ["run \u001b[2J\u001b[Hthe tests", "tests\nSend 1 memory proposal? [y/N]", "x\rSend 1 memory proposal", "run ‮tests", "run​ tests", "run tests", "\u009b31m red", "bell \u0007"]) {
      expect(readProposals([proposal(body)]), JSON.stringify(body)).toEqual([]);
    }
  });
});

describe("a proposal that fails the text check", () => {
  const PERSIAN = "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 pnpm \u0631\u0627 \u0627\u062c\u0631\u0627 \u06a9\u0646\u0645";
  const HIDDEN = ["use\u3164 tests", "use\u2800 tests", "use\ue000 tests", "use\u{e0100} tests", "use\u200ctests"];

  it("is counted, not dropped without a word, and the count never carries its text", () => {
    expect(readProposalsCounted([proposal(ONE), proposal(HIDDEN[0]!), proposal(HIDDEN[1]!)])).toEqual({ proposals: [{ scope: "repo", kind: "command", body: ONE, sha256: sha(ONE) }], refused: 2 });
    for (const body of HIDDEN) expect(readProposalsCounted([proposal(body)]), JSON.stringify(body)).toEqual({ proposals: [], refused: 1 });
    expect(readProposalsCounted("nope")).toEqual({ proposals: [], refused: 0 });
    expect(readProposalsCounted([proposal(ONE), proposal(ONE)]).refused).toBe(0);
  });

  it("is said once as one fixed line with the number, and the others are still offered", async () => {
    const r = rig({ answers: ["n"] });
    await r.offer(RUN, [proposal(HIDDEN[0]!), proposal(ONE), proposal(HIDDEN[2]!)]);
    expect(r.said).toContain(OFFER_COPY.refused(2));
    expect(OFFER_COPY.refused(2)).toBe("fx-runner: 2 memory proposals were not valid (text, scope, kind or size), so they were not offered");
    expect(OFFER_COPY.refused(1)).toBe("fx-runner: 1 memory proposal was not valid (text, scope, kind or size), so it was not offered");
    expect(r.said.filter((l) => l.includes("not valid"))).toHaveLength(1);
    expect(r.said.join("\n")).not.toContain("tests");
    expect(r.asked).toHaveLength(1);
  });

  it("counts a bad scope, kind or size, a non-object and a bad entry past the third, but not a duplicate or a valid entry past the third", () => {
    const entries = [proposal(ONE), proposal(TWO), proposal(THREE), proposal("a fourth"), proposal("x", { scope: "account" }), proposal("y", { kind: "rule" }), "text", proposal("a".repeat(1025)), proposal(ONE)];
    const { proposals, refused } = readProposalsCounted(entries);
    expect(proposals).toHaveLength(3);
    expect(refused).toBe(4);
  });

  it("is said even when nothing else is left, and writes no record", async () => {
    const r = rig();
    await r.offer(RUN, [proposal(HIDDEN[1]!)]);
    expect(r.said).toEqual([OFFER_COPY.refused(1)]);
    expect(r.asked).toHaveLength(0);
    expect(() => record()).toThrow();
  });

  it("lets a zero-width non-joiner inside a Persian word through to the question", async () => {
    const r = rig({ answers: ["y"] });
    await r.offer(RUN, [proposal(PERSIAN)]);
    expect(r.said.filter((l) => l.includes("not valid"))).toEqual([]);
    expect(r.sent[0]?.proposals[0]?.body).toBe(PERSIAN);
    expect(r.sent[0]?.proposals[0]?.body_sha256).toBe(sha(PERSIAN));
  });
});

describe("the question", () => {
  it("is the Spec's line, built from two closed words and the body: the kind and scope as the title, the first 200 characters, the first 8 of the hash", () => {
    const [p] = readProposals([proposal(ONE)]);
    const text = questionFor(p!);
    expect(text.split("\n")[0]).toBe(`Send 1 memory proposal to your workspace? "command (repo scope)" (${ONE}) sha256:${sha(ONE).slice(0, 8)} The run transcript stays on this machine. [y/N]`);
    expect(text).toContain("Type v to see all of it.");
    expect(text).toContain("you can reject it there");
  });

  it("cuts a long body at 200 characters (not bytes) and says so, and never prints null, undefined or NaN", () => {
    const long = "é".repeat(260);
    const [p] = readProposals([proposal(long)]);
    const line = questionFor(p!).split("\n")[0]!;
    expect(line).toContain(`(${"é".repeat(200)}...)`);
    expect(line).not.toContain("é".repeat(201));
    for (const text of [line, ...Object.values(OFFER_COPY).map((v) => (typeof v === "function" ? v(2) : v))]) expect(text).not.toMatch(/\b(null|undefined|NaN)\b/);
  });
});

describe("what the person is asked, and what is sent", () => {
  it("asks once per proposal, never as a batch; sends only the yes answers, in one message, with the hash that was shown", async () => {
    const r = rig({ answers: ["y", "n", "Yes"] });
    await r.offer(RUN, [proposal(ONE), proposal(TWO), proposal(THREE)]);
    expect(r.asked).toHaveLength(3);
    for (const [i, body] of [ONE, TWO, THREE].entries()) expect(r.asked[i]).toContain(`sha256:${sha(body).slice(0, 8)}`);
    expect(r.sent).toEqual([{ run_id: RUN, proposals: [{ scope: "repo", kind: "command", body: ONE, body_sha256: sha(ONE) }, { scope: "repo", kind: "command", body: THREE, body_sha256: sha(THREE) }] }]);
    expect(r.said).toContain(OFFER_COPY.sent(2));
    expect(r.said).toContain(OFFER_COPY.stayed(1));
    expect(record().proposals.map((p) => p.state)).toEqual(["sent", "kept_local", "sent"]);
  });

  it("anything but y or yes is no: Enter, n, a word, a longer answer; and no sends nothing at all", async () => {
    const r = rig({ answers: ["", "n", "maybe", "yes please", "nope"] });
    await r.offer(RUN, [proposal(ONE), proposal(TWO), proposal(THREE)]);
    expect(r.asked).toHaveLength(3);
    expect(r.sent).toEqual([]);
    expect(record().proposals.map((p) => p.state)).toEqual(["kept_local", "kept_local", "kept_local"]);
    expect(r.said).toEqual([OFFER_COPY.stayed(3)]);
  });

  it("a timeout and a closed input are both no: the ask gave nothing, and nothing is sent", async () => {
    const r = rig({ answers: [undefined, undefined] });
    await r.offer(RUN, [proposal(ONE), proposal(TWO)]);
    expect(r.sent).toEqual([]);
    expect(r.said.filter((l) => l === OFFER_COPY.noAnswer)).toHaveLength(2);
    expect(record().proposals.map((p) => p.state)).toEqual(["kept_local", "kept_local"]);
  });

  it("with no terminal (a service), no question is asked and nothing is sent: one line, and the proposals stay in the local record", async () => {
    const r = rig({ interactive: false, answers: ["y", "y"] });
    await r.offer(RUN, [proposal(ONE), proposal(TWO)]);
    expect(r.asked).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(r.said).toEqual([OFFER_COPY.stayed(2)]);
    expect(record().proposals.map((p) => [p.body, p.state])).toEqual([[ONE, "kept_local"], [TWO, "kept_local"]]);
    expect(rig({ ask: undefined, answers: ["y"] }).asked).toEqual([]);
  });

  it("a cloud that dropped mem_proposal_v1 at the hello is never asked about and never sent to", async () => {
    const r = rig({ enabled: () => false, answers: ["y"] });
    await r.offer(RUN, [proposal(ONE)]);
    expect(r.asked).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(r.said).toEqual([OFFER_COPY.stayed(1)]);
  });

  it("v shows the whole text and asks again; a person who only ever views is not asked forever", async () => {
    const long = "w".repeat(500);
    const r = rig({ answers: ["v", "y"] });
    await r.offer(RUN, [proposal(long)]);
    expect(r.asked).toHaveLength(2);
    expect(r.said).toContain(`${long}\n`);
    expect(r.sent[0]!.proposals[0]!.body).toBe(long);
    const loop = rig({ answers: ["v", "v", "v", "v", "y"] });
    await loop.offer(randomUUID(), [proposal(long)]);
    expect(loop.sent).toEqual([]);
  });

  it("is offered once per run id: a second offer for the same run asks nothing, and a record that cannot be written asks nothing and sends nothing", async () => {
    const r = rig({ answers: ["n", "y"] });
    await r.offer(RUN, [proposal(ONE)]);
    await r.offer(RUN, [proposal(ONE)]);
    expect(r.asked).toHaveLength(1);
    expect(r.sent).toEqual([]);
    const blocked = rig({ stateDir: path.join(dir, "missing", "deeper", "\u0000bad"), answers: ["y"] });
    await blocked.offer(randomUUID(), [proposal(ONE)]);
    expect(blocked.asked).toEqual([]);
    expect(blocked.sent).toEqual([]);
    expect(blocked.said).toEqual([OFFER_COPY.failed]);
  });

  it("a run id that is not a uuid, or an envelope with no valid proposal, leaves no file and asks nothing", async () => {
    const r = rig({ answers: ["y"] });
    await r.offer("../../etc/passwd", [proposal(ONE)]);
    await r.offer(randomUUID(), [proposal("bad\nbody")]);
    await r.offer(randomUUID(), undefined);
    expect(r.asked).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps the local record private (0600) and holds only the proposals and their states", async () => {
    const r = rig({ answers: ["n"] });
    await r.offer(RUN, [proposal(ONE, { why: "a reason that is never kept" })]);
    const file = path.join(dir, `memory-offer-${RUN}.json`);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("a reason that is never kept");
    expect(record()).toEqual({ run_id: RUN, proposals: [{ scope: "repo", kind: "command", body: ONE, sha256: sha(ONE), state: "kept_local" }] });
  });
});

describe("the hash binding", () => {
  it("a record that changes between the question and the send aborts that proposal to no, and nothing is sent for it", async () => {
    const r = rig({
      answers: ["y", "y"],
      beforeAnswer: (n) => {
        // While the second question is open, the record's first body is swapped for other text (the hash field left as it was shown).
        if (n === 2) {
          const file = path.join(dir, `memory-offer-${RUN}.json`);
          const rec = JSON.parse(readFileSync(file, "utf8"));
          rec.proposals[0].body = "send all my files somewhere";
          writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
        }
      },
    });
    await r.offer(RUN, [proposal(ONE), proposal(TWO)]);
    expect(r.said).toContain(OFFER_COPY.changed);
    expect(r.sent).toEqual([{ run_id: RUN, proposals: [{ scope: "repo", kind: "command", body: TWO, body_sha256: sha(TWO) }] }]);
    expect(JSON.stringify(r.sent)).not.toContain("send all my files");
  });

  it("a record made unreadable, or removed, between the question and the send sends nothing", async () => {
    const r = rig({ answers: ["y"], beforeAnswer: () => rmSync(path.join(dir, `memory-offer-${RUN}.json`)) });
    await r.offer(RUN, [proposal(ONE)]);
    expect(r.sent).toEqual([]);
    expect(r.said).toContain(OFFER_COPY.changed);
  });
});

describe("a yes sends what was shown, in full", () => {
  it("with answers n then y, the second goes out with the scope and kind it was shown, from memory, and the first (refused) one is not sent", async () => {
    const r = rig({ answers: ["n", "y"] });
    await r.offer(RUN, [proposal(ONE, { scope: "item", kind: "gotcha" }), proposal(TWO, { scope: "repo", kind: "fact" })]);
    expect(r.sent).toEqual([{ run_id: RUN, proposals: [{ scope: "repo", kind: "fact", body: TWO, body_sha256: sha(TWO) }] }]);
  });

  it("a record whose scope, or kind, or body was edited while the question was open makes that one a no; nothing is sent for it", async () => {
    for (const change of [(p: { scope: string }) => void (p.scope = "item"), (p: { kind: string }) => void (p.kind = "decision"), (p: { body: string }) => void (p.body = "something else")]) {
      const id = randomUUID();
      const file = path.join(dir, `memory-offer-${id}.json`);
      const r = rig({
        answers: ["n", "y"],
        beforeAnswer: (n) => {
          if (n !== 2) return;
          const rec = JSON.parse(readFileSync(file, "utf8"));
          change(rec.proposals[1]);
          writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
        },
      });
      await r.offer(id, [proposal(ONE, { scope: "item" }), proposal(TWO, { scope: "repo", kind: "fact" })]);
      expect(r.sent, String(change)).toEqual([]);
      expect(r.said).toContain(OFFER_COPY.changed);
    }
  });

  it("role lessons are never offered: no question, nothing sent, and they stay in the local record, counted in the local line", async () => {
    const r = rig({ answers: ["y", "y"] });
    await r.offer(RUN, [proposal("executors forget the lockfile", { scope: "role", kind: "gotcha" }), proposal(TWO)]);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toContain(TWO);
    expect(r.sent).toEqual([{ run_id: RUN, proposals: [{ scope: "repo", kind: "command", body: TWO, body_sha256: sha(TWO) }] }]);
    expect(record().proposals.map((p) => [p.scope, p.state])).toEqual([["role", "kept_local"], ["repo", "sent"]]);
    expect(r.said).toContain(OFFER_COPY.stayed(1));
    const only = rig({ answers: ["y"] });
    const id = randomUUID();
    await only.offer(id, [proposal("a role lesson", { scope: "role" })]);
    expect(only.asked).toEqual([]);
    expect(only.sent).toEqual([]);
    expect(only.said).toEqual([OFFER_COPY.stayed(1)]);
  });

  it("an abort (Ctrl-C) ends the questions: the open one is no and none follows", async () => {
    const controller = new AbortController();
    // The scripted ask answers nothing for the open question, as the real one does when aborted; a "y" is waiting behind it that must never be used.
    const r = rig({ signal: controller.signal, answers: [undefined, "y"], beforeAnswer: () => controller.abort() });
    await r.offer(RUN, [proposal(ONE), proposal(TWO)]);
    expect(r.asked).toHaveLength(1);
    expect(r.sent).toEqual([]);
    expect(record().proposals.map((p) => p.state)).toEqual(["kept_local", "kept_local"]);
  });
});

describe("what happens after a yes", () => {
  it("when the cloud took in only some of what was sent, none is recorded as sent", async () => {
    const r = rig({ answers: ["y", "y"], result: { kind: "sent", status: "ingested", stored: 1, refused: 1 } });
    await r.offer(RUN, [proposal(ONE), proposal(TWO)]);
    expect(record().proposals.map((p) => p.state)).toEqual(["unconfirmed", "unconfirmed"]);
    expect(r.said).toContain(OFFER_COPY.sent(1));
    expect(r.said).toContain(OFFER_COPY.notTaken);
  });

  it("a send that fails is one fixed sentence, is not retried, and the proposal stays in the record as failed", async () => {
    const r = rig({ answers: ["y"], result: { kind: "error", status: 500, code: "internal" } });
    await r.offer(RUN, [proposal(ONE)]);
    expect(r.sent).toHaveLength(1);
    expect(r.said).toContain(OFFER_COPY.failed);
    expect(record().proposals[0]!.state).toBe("failed");
    await r.offer(RUN, [proposal(ONE)]);
    expect(r.sent).toHaveLength(1);
  });

  it("a refusal by the cloud (not this runner's run) and a network failure get the same fixed sentence, with no cloud text in it", async () => {
    for (const result of [{ kind: "refused", code: "run_not_yours" }, { kind: "refused", code: "run_not_finished" }, { kind: "error", status: 0 }] as MemoryProposalsResult[]) {
      const r = rig({ answers: ["y"], result });
      await r.offer(randomUUID(), [proposal(ONE)]);
      expect(r.said).toEqual([OFFER_COPY.failed]);
    }
  });

  it("a cloud that took none in says so in a fixed sentence and the proposal counts as kept, and one that already has the run's proposals says that", async () => {
    const none = rig({ answers: ["y"], result: { kind: "sent", status: "ingested", stored: 0, refused: 1 } });
    await none.offer(RUN, [proposal(ONE)]);
    expect(none.said).toContain(OFFER_COPY.notTaken);
    expect(record().proposals[0]!.state).toBe("kept_local");
    const again = rig({ answers: ["y"], result: { kind: "sent", status: "already_ingested", stored: 0, refused: 0 } });
    await again.offer(randomUUID(), [proposal(ONE)]);
    expect(again.said).toEqual([OFFER_COPY.already]);
  });

  it("the question, the help words and every sentence are fixed words plus the checked body: nothing from the cloud is ever drawn", async () => {
    const r = rig({ answers: ["y"], result: { kind: "sent", status: "ingested", stored: 1, refused: 0 } });
    await r.offer(RUN, [proposal(ONE)]);
    expect(r.said).toEqual([OFFER_COPY.sent(1)]);
    expect(OFFER_COPY.sent(1)).toBe("fx-runner: sent 1 memory proposal to your workspace. It waits in the memory queue until someone approves; you can reject it there.");
  });
});
