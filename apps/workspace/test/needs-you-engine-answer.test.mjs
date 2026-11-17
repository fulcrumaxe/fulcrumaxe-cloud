// apps/workspace/test/needs-you-engine-answer.test.mjs
//
// EB-13b: answering an engine ask from Needs you (needs-you-model.js), against a fake call(). Pinned here: the one command that is sent
// (`answer_ask`, a closed choice, a trimmed optional note, one idempotency key per ask, choice and note), who may send (owner or admin), when the controls are locked and why
// (operate off, watch off; a halted engine is NOT a lock), the note's length and character rules said before anything is sent, a decision ask (approve or decline, through the
// decision route when the ask carries its receipt id), the outcome of a sent answer read from the engine's own report and said once, "Send again" as a new command, and a
// plain fixed sentence for every refusal and every 409.
import { describe, expect, it, vi } from "vitest";
import { ANSWER_WORDS, ASKS_FIRST_URL, ENGINE_REPOS_URL, LIST_URL, MERGE_URL, NEEDS_HUMAN_URL, SIGN_IN_URL, STALLED_URL, NOTE_MAX, answerable, choicesFor, commandsUrl, createNeedsYou, decisionAnswerUrl, engineAsksUrl, failureSentence, lockReason, noteProblem, readEngineAsk, sendFailure, stateWords } from "../apps/needs-you/needs-you-model.js";

const R1 = "6f1c2f5e-3d8f-4f43-8d6e-8f2f6a9b1c22";
const ASK = "0123456789abcdef";
const ROW = "engine-" + R1 + "-" + ASK;
const CMD = "11111111-2222-4333-8444-555555555555";
const DEC = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SERVER_TEXT = "server text that must never be shown";
const fail = (status, code = "x") => Object.assign(new Error(SERVER_TEXT), { status, code });
const repo = (over = {}) => ({ repo_id: R1, full_name: "acme-labs/widgets", liveness: "live", watch_enabled: true, operate_enabled: true, halted: false, ...over });
const ask = (over = {}) => ({ ask_id: ASK, ask_kind: "owner_decision", source: "team_log", discussion: 42, pr: null, raised_at: "2026-11-16T09:00:00.000Z", cleared_at: null, how: null, ...over });
const listOf = (items) => ({ items, next_cursor: null, as_of: "2026-11-16T09:59:30.000Z", heard_age_s: 30, source_ages_s: {}, gaps: [], missing_events: 0 });
const command = (state, over = {}) => ({ commands: [{ id: CMD, state, refusal: null, ...over }] });

/** A call() over a mutable table of routes; POSTs are logged with their body and options. */
function harness({ repos = [repo()], asks = [ask()], admin = true, post = {}, commands = command("pending") } = {}) {
  const table = {
    ["GET " + ENGINE_REPOS_URL]: () => listOf(repos),
    ["GET " + engineAsksUrl(R1)]: () => listOf(asks),
    ["GET " + commandsUrl(R1)]: () => commands,
    ["GET " + ASKS_FIRST_URL]: { data: [], next_cursor: null },
    ["GET " + MERGE_URL]: { items: [], not_shown: 0 },
    ["GET " + STALLED_URL]: { items: [], not_shown: 0 },
    ["GET " + SIGN_IN_URL]: { items: [] },
    ["GET " + NEEDS_HUMAN_URL]: { data: [], next_cursor: null },
    ["GET " + LIST_URL]: { requests: [], truncated: false },
    ["GET /api/cloud/auth/me"]: { is_admin: admin },
    ["POST " + commandsUrl(R1)]: { command_id: CMD, state: "pending", expires_at: new Date(Date.now() + 600000).toISOString() },
    ["POST " + decisionAnswerUrl(DEC)]: { decision_id: DEC, choice: "approve" },
    ...post,
  };
  const posts = [];
  const call = vi.fn(async (method, path, body, _signal, opts) => {
    if (method === "POST") posts.push({ path, body, key: opts && opts.idempotencyKey });
    const r = table[method + " " + path];
    if (r === undefined) throw fail(404, "not_found");
    const v = typeof r === "function" ? r() : r;
    if (v instanceof Error) throw v;
    return v;
  });
  const ctl = { table, repos, asks, set(k, v) { table[k] = v; } };
  return { call, posts, ctl };
}
async function ready(opts) {
  const h = harness(opts);
  const list = createNeedsYou({ call: h.call, now: () => Date.parse("2026-11-16T10:00:00.000Z") });
  await list.load();
  return { ...h, list };
}

describe("the note", () => {
  it("up to 500 characters of one line is fine, an empty note too", () => {
    expect(noteProblem("")).toBe("");
    expect(noteProblem("Looks good, merge when the checks are green.")).toBe("");
    expect(noteProblem("x".repeat(NOTE_MAX))).toBe("");
  });
  it("501 characters is refused with its own sentence", () => {
    expect(noteProblem("x".repeat(NOTE_MAX + 1))).toBe(ANSWER_WORDS.noteLong);
  });
  it("a line break, a tab, a control, a direction mark, a zero-width or format character and a lone surrogate are refused", () => {
    for (const bad of ["a\nb", "a\rb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "a\u2028b", "a\u202eb", "a\u2066b", "a\u200eb", "a\u200bb", "a\ufeffb", "a\u{e0041}b", "a\ud800b"]) {
      expect(noteProblem(bad), JSON.stringify(bad)).toBe(ANSWER_WORDS.noteBad);
    }
  });
  it("ordinary punctuation, accents and emoji are only text, and are allowed; markup brackets are not (the engine host refuses them)", () => {
    expect(noteProblem("ok & \"quoted\" - café 👍")).toBe("");
    expect(noteProblem("<b>ok</b>")).toBe(ANSWER_WORDS.noteBrackets);
    expect(noteProblem(5)).toBe(ANSWER_WORDS.noteBad);
  });
});

describe("what an engine row offers", () => {
  const row = (over = {}) => readEngineAsk(repo(), listOf([]), ask(over), 0);
  it("Approve, Decline and Defer, and a decision ask has no Defer", () => {
    expect(choicesFor(row())).toEqual(["approve", "decline", "defer"]);
    expect(choicesFor(row({ ask_kind: "decision" }))).toEqual(["approve", "decline"]);
  });
  it("is answerable only with an ask id of 16 hex digits, or a decision's receipt id", () => {
    expect(answerable(row())).toBe(true);
    for (const id of ["one", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0"]) expect(answerable(row({ ask_id: id })), id).toBe(false);
    expect(answerable(row({ ask_id: "short", ask_kind: "decision", decision_id: DEC }))).toBe(true);
    expect(answerable(row({ ask_id: "short", ask_kind: "owner_decision", decision_id: DEC }))).toBe(false);
    expect(row({ ask_kind: "decision", decision_id: "not-a-uuid" }).decisionId).toBe("");
  });
  it("is locked, with a reason, while operate or watch is off, and not while the engine is halted", () => {
    expect(lockReason(row())).toBe("");
    expect(lockReason(readEngineAsk(repo({ operate_enabled: false }), listOf([]), ask(), 0))).toBe(ANSWER_WORDS.lockOperate);
    expect(lockReason(readEngineAsk(repo({ operate_enabled: undefined }), listOf([]), ask(), 0))).toBe(ANSWER_WORDS.lockOperate);
    expect(lockReason(readEngineAsk(repo({ watch_enabled: false }), listOf([]), ask(), 0))).toBe(ANSWER_WORDS.lockWatch);
    const halted = readEngineAsk(repo({ halted: true }), listOf([]), ask(), 0);
    expect(halted.halted).toBe(true);
    expect(lockReason(halted)).toBe("");
  });
});

describe("sending an answer", () => {
  it("sends one answer_ask command: the ask's id, the choice and the trimmed note, with one idempotency key", async () => {
    const { list, posts } = await ready();
    list.setNote(ROW, "  Go ahead.  ");
    await list.answerEngine(ROW, "approve");
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe("/api/v1/engine/repos/" + R1 + "/commands");
    expect(posts[0].body).toEqual({ kind: "answer_ask", args: { ask_id: ASK, choice: "approve", note: "Go ahead." } });
    expect(posts[0].key).toMatch(/^[0-9a-f-]{36}$/);
    expect(list.engineSent(ROW)).toMatchObject({ state: "pending", choice: "approve", note: "Go ahead.", commandId: CMD });
  });

  it("no note means no note key at all; Defer is a choice", async () => {
    const { list, posts } = await ready();
    list.setNote(ROW, "   ");
    await list.answerEngine(ROW, "defer");
    expect(posts[0].body).toEqual({ kind: "answer_ask", args: { ask_id: ASK, choice: "defer" } });
  });

  it("says that it was sent, once, and a second press while it waits sends nothing", async () => {
    const { list, posts } = await ready();
    await list.answerEngine(ROW, "decline");
    expect(list.state.announce).toBe(stateWords(list.engineSent(ROW)));
    expect(list.state.announce).toMatch(/^Sent: Decline\./);
    list.clearAnnounce();
    await list.answerEngine(ROW, "approve");
    expect(posts).toHaveLength(1);
    expect(list.state.announce).toBe("");
  });

  it("two presses at once send one command", async () => {
    const { list, posts } = await ready();
    await Promise.all([list.answerEngine(ROW, "approve"), list.answerEngine(ROW, "approve")]);
    expect(posts).toHaveLength(1);
  });

  it("a member sends nothing, and neither does a locked row, a choice the ask does not offer, or an ask that cannot be answered", async () => {
    const member = await ready({ admin: false });
    await member.list.answerEngine(ROW, "approve");
    expect(member.posts).toHaveLength(0);
    const off = await ready({ repos: [repo({ operate_enabled: false })] });
    await off.list.answerEngine(ROW, "approve");
    expect(off.posts).toHaveLength(0);
    const watchOff = await ready({ repos: [repo({ watch_enabled: false })] });
    expect(watchOff.list.state.rows).toHaveLength(0); // an unwatched repo's asks are not read at all
    const decision = await ready({ asks: [ask({ ask_kind: "decision" })] });
    await decision.list.answerEngine(ROW, "defer");
    await decision.list.answerEngine(ROW, "maybe");
    await decision.list.answerEngine("engine-nope", "approve");
    expect(decision.posts).toHaveLength(0);
    const odd = await ready({ asks: [ask({ ask_id: "not-hex" })] });
    await odd.list.answerEngine("engine-" + R1 + "-not-hex", "approve");
    expect(odd.posts).toHaveLength(0);
  });

  it("a halted engine still takes an answer", async () => {
    const { list, posts } = await ready({ repos: [repo({ halted: true })] });
    await list.answerEngine(ROW, "approve");
    expect(posts).toHaveLength(1);
  });

  it("a note that cannot be sent is said and nothing is sent; focus goes back to the field", async () => {
    const { list, posts } = await ready();
    list.setNote(ROW, "two\nlines");
    await list.answerEngine(ROW, "approve");
    expect(posts).toHaveLength(0);
    expect(list.state.error).toBe(ANSWER_WORDS.noteBad);
    expect(list.state.focusAct).toEqual({ id: ROW, act: "note" });
    list.setNote(ROW, "x".repeat(501));
    await list.answerEngine(ROW, "approve");
    expect(list.state.error).toBe(ANSWER_WORDS.noteLong);
    expect(posts).toHaveLength(0);
  });

  it("typing a note does not redraw, and the draft is kept", async () => {
    const h = harness();
    const onChange = vi.fn();
    const list = createNeedsYou({ call: h.call, onChange });
    await list.load();
    onChange.mockClear();
    list.setNote(ROW, "draft");
    expect(onChange).not.toHaveBeenCalled();
    expect(list.noteOf(ROW)).toBe("draft");
    list.setNote(ROW, 5);
    expect(list.noteOf(ROW)).toBe("draft");
  });

  it("a repeat after a failed network try replays the same key; a changed choice or note is a new key", async () => {
    const { list, posts, ctl } = await ready();
    ctl.set("POST " + commandsUrl(R1), fail(0, "offline"));
    await list.answerEngine(ROW, "approve");
    await list.answerEngine(ROW, "approve");
    await list.answerEngine(ROW, "decline");
    expect(posts).toHaveLength(3);
    expect(posts[1].key).toBe(posts[0].key);
    expect(posts[2].key).not.toBe(posts[0].key);
  });
});

describe("a decision ask", () => {
  it("is answered through the decision route when it carries its receipt id: approve or decline, no note", async () => {
    const { list, posts } = await ready({ asks: [ask({ ask_kind: "decision", decision_id: DEC })] });
    list.setNote(ROW, "ignored");
    await list.answerEngine(ROW, "approve");
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe("/api/v1/engine/decisions/" + DEC + "/answer");
    expect(posts[0].body).toEqual({ choice: "approve" });
    expect(list.engineSent(ROW)).toMatchObject({ state: "applied", viaDecision: true });
    expect(list.state.announce).toMatch(/^Answered: Approve\./);
  });

  it("without a receipt id it goes through the command channel like any other ask, with approve or decline", async () => {
    const { list, posts } = await ready({ asks: [ask({ ask_kind: "decision" })] });
    await list.answerEngine(ROW, "decline");
    expect(posts[0].path).toBe(commandsUrl(R1));
    expect(posts[0].body.args.choice).toBe("decline");
  });
});

describe("the outcome of a sent answer", () => {
  const sentList = async (commands, opts = {}) => {
    const h = await ready({ commands, ...opts });
    await h.list.answerEngine(ROW, "approve");
    h.list.clearAnnounce();
    return h;
  };

  it("stays 'sent' while the engine has not reported, and says nothing new", async () => {
    const { list } = await sentList(command("delivered"));
    await list.watchSent();
    expect(list.engineSent(ROW).state).toBe("pending");
    expect(list.state.announce).toBe("");
  });

  it("applied is said once, and the asks are read again until the ask clears", async () => {
    const { list, call, ctl } = await sentList(command("applied"));
    call.mockClear();
    await list.watchSent();
    expect(list.engineSent(ROW).state).toBe("applied");
    expect(list.state.announce).toBe(stateWords({ state: "applied", choice: "approve" }));
    list.clearAnnounce();
    await list.watchSent(); // nothing is waiting any more: it is not said again
    expect(list.state.announce).toBe("");
    // the ask is not cleared yet in the engine's read: the row stays and its controls stay still
    expect(list.state.rows.map((r) => r.id)).toEqual([ROW]);
    // the engine clears it: the row leaves, with its sent state and draft
    list.setNote(ROW, "bye");
    ctl.set("GET " + engineAsksUrl(R1), listOf([]));
    await list.loadEngine();
    expect(list.state.rows).toHaveLength(0);
    expect(list.engineSent(ROW)).toBeNull();
    expect(list.noteOf(ROW)).toBe("");
    expect(list.state.announce).toMatch(/1 engine ask cleared\./);
  });

  it("a refusal shows the engine's own reason by its closed code, and Send again sends a new command with the same choice", async () => {
    const { list, posts, ctl } = await sentList(command("refused", { refusal: "host_not_running" }));
    await list.watchSent();
    expect(list.engineSent(ROW)).toMatchObject({ state: "refused", refusal: "host_not_running" });
    expect(list.state.announce).toBe(ANSWER_WORDS.refusals.host_not_running);
    ctl.set("POST " + commandsUrl(R1), { command_id: "22222222-3333-4444-8555-666666666666", state: "pending", expires_at: "2026-11-16T10:20:00.000Z" });
    await list.sendAgain(ROW);
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toEqual(posts[0].body);
    expect(posts[1].key).not.toBe(posts[0].key);
    expect(list.engineSent(ROW).state).toBe("pending");
  });

  it("every refusal in the closed list has a sentence of its own, and an unknown one reads as a plain refusal", () => {
    const codes = ["signature_invalid", "wrong_runner", "wrong_repo", "expired", "seq_not_increasing", "halted", "operate_off", "host_not_running", "unknown_ask", "unknown_agent", "ceiling", "already_answered"];
    const words = codes.map((c) => stateWords({ state: "refused", refusal: c, choice: "approve" }));
    expect(new Set(words).size).toBe(codes.length);
    for (const w of words) expect(w).not.toMatch(/_|null|undefined/);
    for (const c of ["something_new", "__proto__", "constructor", "", null]) expect(stateWords({ state: "refused", refusal: c, choice: "approve" })).toBe(ANSWER_WORDS.refusalOther);
  });

  it("expired and not_confirmed each say so and offer Send again", async () => {
    const expired = await sentList(command("expired"));
    await expired.list.watchSent();
    expect(expired.list.state.announce).toBe(ANSWER_WORDS.expired);
    const lost = await sentList(command("not_confirmed"));
    await lost.list.watchSent();
    expect(lost.list.state.announce).toBe(ANSWER_WORDS.notConfirmed);
    await lost.list.sendAgain(ROW);
    expect(lost.posts).toHaveLength(2);
  });

  it("a command the list no longer shows stays 'sent' until 15 minutes past its life, then reads 'not confirmed'; a failed look is tried again", async () => {
    const { list, ctl } = await sentList({ commands: [] });
    await list.watchSent();
    expect(list.engineSent(ROW).state).toBe("pending");
    ctl.set("GET " + commandsUrl(R1), fail(500, "server_error"));
    await list.watchSent();
    expect(list.engineSent(ROW).state).toBe("pending");
    expect(list.state.announce).toBe("");
    const late = await ready({ commands: { commands: [] }, post: { ["POST " + commandsUrl(R1)]: { command_id: CMD, state: "pending", expires_at: new Date(Date.now() - 16 * 60000).toISOString() } } });
    await late.list.answerEngine(ROW, "approve");
    await late.list.watchSent();
    expect(late.list.engineSent(ROW).state).toBe("not_confirmed");
  });

  it("looks again on a timer while an answer waits, and stops when the window stops", async () => {
    const h = harness({ commands: command("delivered") });
    const list = createNeedsYou({ call: h.call });
    await list.load();
    const timers = [];
    const setDelay = vi.fn((fn, ms) => (timers.push({ fn, ms }), timers.length));
    const clearDelay = vi.fn();
    list.start({ subscribe: () => () => {}, listen: () => () => {}, setTimer: () => 1, clearTimer: () => {}, setDelay, clearDelay });
    await list.answerEngine(ROW, "approve");
    const watch = timers.filter((t) => t.ms === 3000);
    expect(watch).toHaveLength(1);
    h.call.mockClear();
    await watch[0].fn();
    expect(h.call.mock.calls.some((c) => c[0] === "GET" && c[1] === commandsUrl(R1))).toBe(true);
    expect(timers.filter((t) => t.ms === 3000)).toHaveLength(2); // still waiting: another look is set
    list.stop();
    expect(clearDelay).toHaveBeenCalled();
  });
});

describe("refusals of the send itself", () => {
  it("every 409 the command route answers has its own plain sentence, and none shows the server's words", async () => {
    const words = new Set();
    for (const code of ["operate_off", "engine_not_connected", "halted", "too_many_pending", "already_answered", "not_asked", "some_new_code"]) {
      const { list, posts } = await ready({ post: { ["POST " + commandsUrl(R1)]: fail(409, code) } });
      await list.answerEngine(ROW, "approve");
      expect(posts).toHaveLength(1);
      expect(list.state.error, code).not.toBe("");
      expect(list.state.error).not.toContain(SERVER_TEXT);
      expect(list.state.error).not.toMatch(/_|null|undefined/);
      expect(list.engineSent(ROW)).toBeNull(); // nothing was sent, so the controls are still there
      words.add(list.state.error);
    }
    expect(words.size).toBe(7); // each known code has its own sentence, and a code this page does not know reads as the common one
  });

  it("a 403, a 404, a rate limit and a server error read as fixed sentences", async () => {
    expect(sendFailure(fail(403), failureSentence)).toBe(failureSentence(fail(403)));
    expect(sendFailure(fail(404), failureSentence)).toBe(ANSWER_WORDS.notFound);
    expect(sendFailure(fail(500), failureSentence)).toBe(failureSentence(fail(500)));
    expect(sendFailure(Object.assign(fail(429, "rate_limited"), { retryAfter: 5 }), failureSentence)).not.toContain(SERVER_TEXT);
    expect(sendFailure(null, failureSentence)).toBe(failureSentence(null));
  });

  it("a refused send reads the list again, so a repo whose operate was switched off shows its lock", async () => {
    const { list, ctl } = await ready({ post: { ["POST " + commandsUrl(R1)]: fail(409, "operate_off") } });
    ctl.repos[0] = repo({ operate_enabled: false });
    await list.answerEngine(ROW, "approve");
    expect(list.state.rows[0].operateEnabled).toBe(false);
    expect(list.state.error).toBe(ANSWER_WORDS.failures.operate_off);
  });
});

// The host's own rule (`cleanNote`, packages/fx-runner/src/engineHost/prompts.ts) is the source of truth: each class below is refused there, so it must be refused here
// with a fixed sentence before anything is sent.
describe("the note, as the engine host will read it", () => {
  const classes = [
    ["square brackets", ["see [D#5] first", "a ] b", "[", "］"], ANSWER_WORDS.noteBrackets],
    ["fullwidth and small-form brackets (NFKC folds them to ASCII)", ["see ［D］", "﹇x﹈"], ANSWER_WORDS.noteBrackets],
    ["bracket lookalikes", ["a ⟦x⟧ b", "a ❲x❳ b", "a 〔x〕 b", "a ⌈x⌉ b", "a ｢x｣ b"], ANSWER_WORDS.noteBrackets],
    ["brackets that only exist once NFKC has folded them", ["a 〈 b", "﹤﹤", "a 〉 b"], ANSWER_WORDS.noteBrackets],
    ["double angles", ["ok >> merge", "a << b"], ANSWER_WORDS.noteBrackets],
    ["a single angle, and the guillemet and ornament lookalikes", ["a < b", "a > b", "a « b", "a » b", "a ‹ b", "a ≪ b", "a ⋙ b", "a ≮ b", "a ❬ b", "a ❱ b", "a ˂ b"], ANSWER_WORDS.noteBrackets],
    ["combining marks next to angles", ["a ≮ b", "a >́ b", "a ́> b", "a <️ b"], ANSWER_WORDS.noteBrackets],
    ["math symbols, braces and the other bracket-like punctuation (anything in Sm, Ps, Pe, Pi or Pf outside the allowlist)", ["a ∑ b", "2 × 3", "x ≠ y", "a ± b", "a | b", "a ~ b", "{x}", "｛x｝", "a ⸂ b", "a ⸃ b", "a ‟ b", "a ‚ b", "a ∞ b"], ANSWER_WORDS.noteSymbols],
    ["the marker words, folded through Cyrillic and Greek lookalike letters", ["еnd untruѕted", "UNTRUSTED ЕXTERNAL СONTENT", "ΕΝD UNTRUSΤED", "еnd unτrusted"], ANSWER_WORDS.noteMarker],
    ["the marker words, however they are spaced, cased or accented", ["end untrusted", "END  UNTRUSTED", "En-d Untrusted", "untrusted external content", "ÛNTRÜSTED  EXTERNAL  CONTENT", "endUntrusted"], ANSWER_WORDS.noteMarker],
    ["the engine's control tokens, in any case", ["STATUS: done", "status : ok", "Spawn_Request now", "terminate_request x", "AGENT_OUTPUT", "agent_output", "a <!-- b", "ＳＰＡＷＮ＿ＲＥＱＵＥＳＴ"], ANSWER_WORDS.noteControl],
  ];
  for (const [name, notes, words] of classes) {
    it(`refuses ${name}, with its own fixed sentence`, () => {
      for (const n of notes) expect(noteProblem(n), JSON.stringify(n)).toBe(words);
    });
  }
  it("refuses a note that is 500 long as typed but longer once NFKC has folded it", () => {
    expect(noteProblem("x".repeat(NOTE_MAX))).toBe("");
    expect(noteProblem("ﷺ".repeat(30))).toBe(ANSWER_WORDS.noteLong); // one character that folds to 18
    expect(noteProblem("ﷺ".repeat(27))).toBe("");
  });
  it("still allows ordinary notes, a status word without a colon, and the allowlisted symbols and curly quotes", () => {
    for (const n of ["Looks good, merge when green.", "the status is fine", "see (D#5) first", "50% done, 3 of 5", "Ünïcödé fine 👍", "a + b = c (50%) / 2 * 3 - 1", "it\u2019s \u201cfine\u201d and \u2018ok\u2019", "Привет, αβγ"]) expect(noteProblem(n), n).toBe("");
  });
  it("sends nothing when the host would refuse the note", async () => {
    const { list, posts } = await ready();
    list.setNote(ROW, "see [D#5] first");
    await list.answerEngine(ROW, "approve");
    expect(posts).toHaveLength(0);
    expect(list.state.error).toBe(ANSWER_WORDS.noteBrackets);
    expect(list.engineSent(ROW)).toBeNull();
  });
  it("the counter says a note is too long", () => {
    expect(ANSWER_WORDS.count(500)).toBe("500 / 500");
    expect(ANSWER_WORDS.count(501)).toBe("501 / 500, too long");
  });
});

describe("a reload remembers an answer that is still waiting or taken", () => {
  // The shape `GET .../commands` returns (engine-commands.ts): the note is a top-level field, only for an owner or admin, never inside `args`.
  const ACKED = "2026-11-16T09:58:00.000Z";
  const waiting = (state, over = {}) => ({ commands: [{ id: CMD, state, refusal: null, kind: "answer_ask", args: { ask_id: ASK, choice: "decline" }, note: "later", expires_at: new Date(Date.now() + 600000).toISOString(), acked_at: null, ...over }] });
  for (const state of ["pending", "delivered"]) {
    it(`shows a ${state} answer for the ask as sent, with its note from the top-level field, and no second send`, async () => {
      const { list, posts } = await ready({ commands: waiting(state) });
      expect(list.engineSent(ROW)).toMatchObject({ state: "pending", choice: "decline", note: "later", commandId: CMD, repoId: R1 });
      await list.answerEngine(ROW, "approve");
      expect(posts).toHaveLength(0);
    });
  }
  it("does not read a note out of args: the route never puts one there", async () => {
    const c = waiting("pending");
    delete c.commands[0].note;
    c.commands[0].args.note = "from args";
    const { list } = await ready({ commands: c });
    expect(list.engineSent(ROW)).toMatchObject({ state: "pending", note: "" });
  });
  it("shows an applied answer as a locked applied state, at the time the engine took it, and sends no second answer", async () => {
    const { list, posts } = await ready({ commands: waiting("applied", { acked_at: ACKED }) });
    const s = list.engineSent(ROW);
    expect(s).toMatchObject({ state: "applied", choice: "decline", note: "later", commandId: CMD, repoId: R1, appliedAt: Date.parse(ACKED), viaDecision: false });
    expect(stateWords(s)).toBe(ANSWER_WORDS.applied("decline"));
    await list.answerEngine(ROW, "approve");
    await list.sendAgain(ROW);
    expect(posts).toHaveLength(0);
  });
  it("an applied answer without a usable acked_at is stamped with the time it was seen", async () => {
    const { list } = await ready({ commands: waiting("applied", { acked_at: "not a date" }) });
    expect(list.engineSent(ROW).appliedAt).toBeGreaterThan(Date.parse(ACKED));
  });
  it("takes the newest of the commands for the ask", async () => {
    const c = { commands: [...waiting("applied", { acked_at: ACKED, args: { ask_id: ASK, choice: "approve" }, id: "99999999-2222-4333-8444-555555555555" }).commands, ...waiting("pending").commands] };
    const { list } = await ready({ commands: c });
    expect(list.engineSent(ROW)).toMatchObject({ state: "applied", choice: "approve" });
  });
  it("does not take a command for another ask, another kind, or one that has not been taken (refused, expired, cancelled, not confirmed)", async () => {
    for (const c of [waiting("pending", { args: { ask_id: "fedcba9876543210", choice: "approve" } }), waiting("pending", { kind: "set_dial" }), waiting("refused"), waiting("expired"), waiting("cancelled"), waiting("not_confirmed")]) {
      const { list } = await ready({ commands: c });
      expect(list.engineSent(ROW)).toBeNull();
      expect(list.engineUnchecked(ROW)).toBe(false);
    }
  });
  it("is looked up once per ask, and not read for a member", async () => {
    const h = await ready({ commands: waiting("pending") });
    const reads = () => h.call.mock.calls.filter((c) => c[0] === "GET" && c[1] === commandsUrl(R1)).length;
    const before = reads();
    await h.list.load();
    expect(reads()).toBe(before);
    const member = await ready({ admin: false, commands: waiting("pending") });
    expect(member.call.mock.calls.some((c) => c[1] === commandsUrl(R1))).toBe(false);
  });
  it("is told once the engine reports it, like an answer sent in this page", async () => {
    const h = await ready({ commands: waiting("pending") });
    h.ctl.set("GET " + commandsUrl(R1), waiting("refused", { refusal: "halted" }));
    await h.list.watchSent();
    expect(h.list.engineSent(ROW)).toMatchObject({ state: "refused", refusal: "halted" });
  });
});

describe("an ask whose waiting answers could not be checked stays locked", () => {
  const waiting = (state) => ({ commands: [{ id: CMD, state, refusal: null, kind: "answer_ask", args: { ask_id: ASK, choice: "decline" }, expires_at: new Date(Date.now() + 600000).toISOString(), acked_at: null }] });
  const filler = (n) => Array.from({ length: n }, (_v, i) => ({ id: "00000000-0000-4000-8000-" + String(i).padStart(12, "0"), state: "applied", refusal: null, kind: "set_dial", args: {}, expires_at: "2026-11-16T09:58:00.000Z", acked_at: "2026-11-16T09:58:00.000Z" }));
  it("a failed command list locks the ask: no send, however it is pressed", async () => {
    const h = await ready({ commands: fail(500, "server_error") });
    expect(h.list.engineUnchecked(ROW)).toBe(true);
    expect(h.list.engineSent(ROW)).toBeNull();
    await h.list.answerEngine(ROW, "approve");
    expect(h.posts).toHaveLength(0);
  });
  it("Try again reads the list once more: still failing stays locked; a read that finds nothing unlocks; one that finds an answer shows it", async () => {
    const h = await ready({ commands: fail(429, "rate_limited") });
    const reads = () => h.call.mock.calls.filter((c) => c[0] === "GET" && c[1] === commandsUrl(R1)).length;
    const before = reads();
    await h.list.recheck(ROW);
    expect(reads()).toBe(before + 1);
    expect(h.list.engineUnchecked(ROW)).toBe(true);
    h.ctl.set("GET " + commandsUrl(R1), { commands: [] });
    await h.list.recheck(ROW);
    expect(h.list.engineUnchecked(ROW)).toBe(false);
    await h.list.answerEngine(ROW, "approve");
    expect(h.posts).toHaveLength(1);
    const h2 = await ready({ commands: fail(500, "server_error") });
    h2.ctl.set("GET " + commandsUrl(R1), waiting("pending"));
    await h2.list.recheck(ROW);
    expect(h2.list.engineUnchecked(ROW)).toBe(false);
    expect(h2.list.engineSent(ROW)).toMatchObject({ state: "pending", choice: "decline" });
  });
  it("the next engine read looks again by itself", async () => {
    const h = await ready({ commands: fail(500, "server_error") });
    h.ctl.set("GET " + commandsUrl(R1), waiting("pending"));
    await h.list.load();
    expect(h.list.engineUnchecked(ROW)).toBe(false);
    expect(h.list.engineSent(ROW)).toMatchObject({ state: "pending" });
  });
  it("a list at the route's cap of 50 without the ask in it is unknown: locked; with the ask in it, or under the cap, it is not", async () => {
    const full = await ready({ commands: { commands: filler(50) } });
    expect(full.list.engineUnchecked(ROW)).toBe(true);
    await full.list.answerEngine(ROW, "approve");
    expect(full.posts).toHaveLength(0);
    const hit = await ready({ commands: { commands: [...filler(49), ...waiting("pending").commands] } });
    expect(hit.list.engineUnchecked(ROW)).toBe(false);
    expect(hit.list.engineSent(ROW)).toMatchObject({ state: "pending" });
    const under = await ready({ commands: { commands: filler(49) } });
    expect(under.list.engineUnchecked(ROW)).toBe(false);
    expect(under.list.engineSent(ROW)).toBeNull();
  });
  it("a full list is conclusive when its oldest command was issued before the ask was raised, and unknown when all 50 are newer", async () => {
    // the ask is raised at 2026-11-16T09:00:00Z
    const at = (iso) => filler(50).map((c) => ({ ...c, issued_at: iso }));
    const older = await ready({ commands: { commands: at("2026-11-16T08:00:00.000Z") } });
    expect(older.list.engineUnchecked(ROW)).toBe(false);
    await older.list.answerEngine(ROW, "approve");
    expect(older.posts).toHaveLength(1);
    const newer = await ready({ commands: { commands: at("2026-11-16T09:30:00.000Z") } });
    expect(newer.list.engineUnchecked(ROW)).toBe(true);
    const mixed = await ready({ commands: { commands: [...at("2026-11-16T09:30:00.000Z").slice(1), { ...at("x")[0], issued_at: "2026-11-16T08:59:00.000Z" }] } });
    expect(mixed.list.engineUnchecked(ROW)).toBe(false);
    const noTime = await ready({ commands: { commands: filler(50) } });
    expect(noTime.list.engineUnchecked(ROW)).toBe(true);
  });
  it("a decision ask goes through the decision route and is never locked by the command list", async () => {
    const h = await ready({ asks: [ask({ ask_kind: "decision", decision_id: DEC })], commands: fail(500, "server_error") });
    expect(h.list.engineUnchecked("engine-" + R1 + "-" + ASK)).toBe(false);
  });
  it("a member never reads the list and is never offered Try again", async () => {
    const m = await ready({ admin: false, commands: fail(500, "server_error") });
    expect(m.list.engineUnchecked(ROW)).toBe(false);
  });
});

describe("a 409 for a request still running", () => {
  it("keeps the idempotency key, so a press again replays the same command; a final refusal drops it", async () => {
    const { list, posts, ctl } = await ready();
    ctl.set("POST " + commandsUrl(R1), fail(409, "idempotency_in_progress"));
    await list.answerEngine(ROW, "approve");
    await list.answerEngine(ROW, "approve");
    expect(posts[1].key).toBe(posts[0].key);
    ctl.set("POST " + commandsUrl(R1), fail(409, "operate_off"));
    await list.answerEngine(ROW, "approve");
    await list.answerEngine(ROW, "approve");
    expect(posts[3].key).not.toBe(posts[2].key);
  });
});
