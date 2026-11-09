import { describe, expect, it } from "vitest";
import { RunLimitError } from "../src/meteringGuard.js";
import { SliceAttachError } from "../src/sandboxPort.js";
import { RECORD_READ_CAP, acceptRecords } from "../src/recordParser.js";
import { assistantLine, envelopeBlock, resultLine, sliceRig, SLICE_REC, SLICE_RUN, type SliceScript, type SliceStore } from "./helpers/sliceRig.js";
import { recordFile } from "./helpers/recorderSdk.js";

const userLine = (): string => JSON.stringify({ type: "user", message: { role: "user", content: "a tool answer" } }) + "\n";
const initLine = (): string => JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\n";

/** A stream with every kind of line the reader tells apart: a repeated message id that rises, a line that is not JSON, a verdict at the end. */
const STREAM: SliceScript = {
  lines: [initLine(), assistantLine("m1", 10), assistantLine("m1", 15), "not json\n", assistantLine("m2", 1000), assistantLine("m3", 2000, "x".repeat(200)), userLine(), assistantLine("m4", 50), resultLine(envelopeBlock("pass"))],
};
/** The records of that run: the header, nine lines, the trailer. */
const RECORDS = STREAM.lines.length + 2;
const MANY = (n: number): string[] => Array.from({ length: n }, (_, i) => assistantLine(`a${i}`, 10 + i));
/** More distinct message ids than the smallest model-call limit the platform allows. */
const LONG: SliceScript = { lines: [initLine(), ...MANY(24), resultLine(envelopeBlock("pass"))] };

describe("RLR-4 a slice boundary changes nothing (B3: the cursor, the state and the effects carried across)", () => {
  it("every single boundary in a recorded stream gives the figures of one in-process read: the same events, total, flags, and verdict", async () => {
    const base = await sliceRig({ script: STREAM }).inProcess();
    expect(base.outcome).toBe("ended");
    expect(base.total).toBe(3065);
    expect(base.final?.agentOutput).toEqual({ verdict: "pass" });
    for (let k = 1; k <= RECORDS; k++) {
      const r = await sliceRig({ script: STREAM }).sliced((i) => (i === 0 ? k : undefined));
      expect(r, `one boundary after ${k} records`).toEqual(base);
    }
  });

  it("a boundary after every record, every two and every three give the same figures", async () => {
    const base = await sliceRig({ script: STREAM }).inProcess();
    for (const n of [1, 2, 3]) {
      const rig = sliceRig({ script: STREAM });
      expect(await rig.sliced(() => n), `a boundary every ${n}`).toEqual(base);
    }
  });

  it("the exit sequence runs once, in the slice that sees the command exit, and the agent command has no subscriber before that", async () => {
    const rig = sliceRig({ script: STREAM });
    const r = await rig.sliced(() => 1);
    expect(r.outcome).toBe("ended");
    const echoes = rig.vm.log.filter((e) => e.kind === "agent_logs");
    expect(echoes).toHaveLength(1);
    expect(echoes[0]).toMatchObject({ exited: true });
    expect(rig.vm.logsBeforeExit()).toBe(0);
    expect(rig.vm.log.some((e) => e.kind === "exit_code_read")).toBe(false);
  });

  it("the trailer read in one slice and the exit in the next: the trailer is carried, the verdict too", async () => {
    const base = await sliceRig({ script: STREAM }).inProcess();
    const rig = sliceRig({ script: STREAM });
    const r = await rig.sliced((i) => (i === 0 ? RECORDS : undefined));
    expect(r).toEqual(base);
    expect(rig.store.cp?.reader.trailer).toMatchObject({ lines: RECORDS - 2 });
  });

  it("a limit decision lands on the same message and ends the run with the same limit, however the stream is cut", async () => {
    const limits = { maxModelCalls: 20 };
    const base = await sliceRig({ script: LONG, limits }).inProcess();
    expect(base.outcome).toBe("rejected:RunLimitError:model_calls");
    for (const n of [1, 2, 5]) {
      const rig = sliceRig({ script: LONG, limits });
      expect(await rig.sliced(() => n), `a boundary every ${n}`).toEqual(base);
      expect(rig.vm.log.filter((e) => e.kind === "agent_kill" && e.sig === "SIGTERM").length).toBeLessThanOrEqual(1);
    }
  });

  it("a spend kill in a later slice ends the run as it does in-process, and nothing after the killing record is delivered", async () => {
    const base = await sliceRig({ script: STREAM, stopAbove: 500 }).inProcess();
    expect(base.outcome).toBe("rejected:Error");
    const r = await sliceRig({ script: STREAM, stopAbove: 500 }).sliced(() => 2);
    expect(r).toEqual(base);
  });

  it("each assistant text is saved under the number of the record line it came from, once, in order", async () => {
    const rig = sliceRig({ script: STREAM });
    await rig.sliced(() => 2);
    const lines = rig.store.rows.map((r) => r.sourceLine);
    expect(lines).toEqual([2, 3, 5, 6, 8]);
    expect(rig.store.rows.map((r) => r.text)).toEqual(["text m1", "text m1", "text m2", "x".repeat(200), "text m4"]);
    // The in-process path passes no line number: its rows are not line-keyed.
    const base = sliceRig({ script: STREAM });
    await base.inProcess();
    expect(base.store.rows).toEqual([]);
  });

  it("the saved state stays inside the column's bound after a long stream", async () => {
    const lines = [initLine(), ...Array.from({ length: 400 }, (_, i) => assistantLine(`id-${i}`, 5)), resultLine(envelopeBlock("pass"))];
    const rig = sliceRig({ script: { lines }, limits: { maxModelCalls: 1000 } });
    const r = await rig.sliced(() => 90);
    expect(r.outcome).toBe("ended");
    expect(Buffer.byteLength(JSON.stringify(rig.store.cp)) < 262_144).toBe(true);
  });
});

describe("RLR-4 checkpoints and the lease", () => {
  it("a run read in one slice saves once, at its end; with a cadence of zero it saves after every record", async () => {
    const a = sliceRig({ script: STREAM });
    await a.sliced(() => undefined);
    expect(a.store.commits).toBe(1);
    expect(a.store.cp).toMatchObject({ final: true, nextSeq: RECORDS });
    const b = sliceRig({ script: STREAM });
    await b.sliced(() => undefined, b.store, { checkpointEveryMs: 0 });
    expect(b.store.commits).toBeGreaterThanOrEqual(RECORDS - 1);
  });

  it("a slice whose time is already up hands over at once, from where it started, with the command left running", async () => {
    const rig = sliceRig({ script: STREAM });
    const cmdId = await rig.startCommand();
    const r = await rig.slice(cmdId, rig.store, { untilMs: Date.now() - 1 });
    expect(r).toEqual({ kind: "slice" });
    expect(rig.store.cp).toMatchObject({ nextSeq: 0, byteOffset: 0, final: true });
    expect(rig.vm.log.some((e) => e.kind === "agent_kill")).toBe(false);
  });

  it("a lease lost at a save ends the slice at once: no kill, no echo replay, no totals reported", async () => {
    const rig = sliceRig({ script: STREAM });
    const cmdId = await rig.startCommand();
    let saves = 0;
    const r = await rig.slice(cmdId, rig.store, { checkpointEveryMs: 0, gate: () => ++saves < 3 });
    expect(r).toEqual({ kind: "lost" });
    expect(rig.vm.log.some((e) => e.kind === "agent_kill" || e.kind === "agent_logs")).toBe(false);
    expect(rig.store.modelCalls).toBeUndefined();
  });

  it("a lease lost during a limit end's catch-up still ends the slice as lost and reports nothing", async () => {
    const rig = sliceRig({ script: LONG, limits: { maxModelCalls: 20 } });
    const cmdId = await rig.startCommand();
    const r = await rig.slice(cmdId, rig.store, { gate: (cp) => !cp.final });
    expect(r).toEqual({ kind: "lost" });
    expect(rig.store.modelCalls).toBeUndefined();
  });

  it("saves that keep failing are not the end of the run: after three in a row the slice stops as lost, without killing the command", async () => {
    const rig = sliceRig({ script: STREAM });
    const cmdId = await rig.startCommand();
    const r = await rig.slice(cmdId, rig.store, {
      checkpointEveryMs: 0,
      commit: async () => {
        throw new Error("database down");
      },
    });
    expect(r).toEqual({ kind: "lost" });
    expect(rig.vm.log.some((e) => e.kind === "agent_kill")).toBe(false);
  });

  it("one failed save is tried again at the next checkpoint and the run goes on", async () => {
    const rig = sliceRig({ script: STREAM });
    const base = await sliceRig({ script: STREAM }).inProcess();
    const cmdId = await rig.startCommand();
    let calls = 0;
    const real = rig.store;
    const r = await rig.slice(cmdId, real, {
      checkpointEveryMs: 0,
      commit: async (cp) => {
        if (++calls === 2) throw new Error("one blip");
        real.cp = JSON.parse(JSON.stringify(cp)) as typeof cp;
        return true;
      },
    });
    expect(r.kind).toBe("ended");
    expect(rig.shapeOf("ended", real, r.kind === "ended" ? r.event : undefined)).toEqual(base);
  });
});

describe("RLR-4 re-attaching", () => {
  it("a command id the session does not know, or a session that is not the command's, is a failed attach: nothing is read, killed or counted", async () => {
    const rig = sliceRig({ script: STREAM });
    const cmdId = await rig.startCommand();
    const unknown = await rig.slice("cmd_does_not_exist", rig.store);
    expect(unknown).toMatchObject({ kind: "rejected" });
    expect((unknown as { error: unknown }).error).toBeInstanceOf(SliceAttachError);
    const otherSession = await rig.slice(cmdId, rig.store, { sessionId: "another-session" });
    expect((otherSession as { error: unknown }).error).toBeInstanceOf(SliceAttachError);
    expect(rig.vm.log.some((e) => e.kind === "read" || e.kind === "agent_kill" || e.kind === "agent_logs")).toBe(false);
    expect(rig.store.commits).toBe(0);
    // The command is found by id on the session, never through the sandbox's resume wrapper.
    expect(rig.vm.log.filter((e) => e.kind === "get_command").map((e) => e.cmdId)).toEqual(["cmd_does_not_exist"]);
  });
});

describe("RLR-4 the exit: a command that ignores SIGTERM (RLR-0c condition 8)", () => {
  it("SIGTERM first, then after the bounded wait SIGKILL, then the echo is replayed, and only then is the run handed back to be stopped", async () => {
    const script: SliceScript = { lines: MANY(24), endless: true };
    const rig = sliceRig({ script, vm: { ignoreSigterm: true }, limits: { maxModelCalls: 20 } });
    const r = await rig.sliced(() => 1);
    expect(r.outcome).toBe("rejected:RunLimitError:model_calls");
    const order = rig.vm.log.filter((e) => e.kind === "agent_kill" || e.kind === "agent_logs" || e.kind === "sandbox_stop").map((e) => (e.kind === "agent_kill" ? `kill:${e.sig}` : e.kind));
    expect(order).toEqual(["kill:SIGTERM", "kill:SIGKILL", "agent_logs"]);
    // The echo is the first subscriber the command ever had, and it came after the command exited.
    expect(rig.vm.log.find((e) => e.kind === "agent_logs")).toMatchObject({ exited: true });
  });

  it("a command that ends on SIGTERM is not sent SIGKILL", async () => {
    const script: SliceScript = { lines: MANY(24), endless: true };
    const rig = sliceRig({ script, limits: { maxModelCalls: 20 } });
    await rig.sliced(() => 1);
    expect(rig.vm.log.filter((e) => e.kind === "agent_kill").map((e) => e.sig)).toEqual(["SIGTERM"]);
  });
});

describe("RLR-4 the exit cross-check across slices: the record file is agent-writable", () => {
  /** What the file shows slice 1: the echo's record 2 is replaced by a line with no usage in it. The echo has all of the usage. */
  const stream: SliceScript = { lines: [assistantLine("m1", 10), assistantLine("m2", 1000), assistantLine("m3", 2000), resultLine("done")] };
  const hidden = (m1 = 10): Buffer => recordFile(SLICE_RUN, [assistantLine("m1", m1).trim(), userLine().trim(), assistantLine("m3", 2000).trim(), resultLine("done").trim()]);

  async function prepare(): Promise<{ rig: ReturnType<typeof sliceRig>; cmdId: string }> {
    const rig = sliceRig({ script: stream });
    const cmdId = await rig.startCommand();
    // Let the scripted agent finish writing, then show the reader the file with the usage taken out.
    await new Promise((r) => setTimeout(r, 30));
    rig.vm.setFile(SLICE_REC, hidden());
    return { rig, cmdId };
  }

  it("a prefix that still gives the saved chain is the file side, as in-process: the echo's record the file hid is delivered and flagged, and nothing else", async () => {
    const { rig, cmdId } = await prepare();
    expect((await rig.slice(cmdId, rig.store, { maxRecords: 3 })).kind).toBe("slice");
    const r = await rig.slice(cmdId, rig.store);
    expect(r.kind).toBe("ended");
    expect(rig.store.total).toBe(3010);
    expect(rig.store.delivered).toContain("m2"); // delivered whole, not meter-only
    expect(rig.flags).toContain("record_mismatch");
    expect(rig.flags).not.toContain("record_file_tampered");
  });

  it("the agent rewrites the part already consumed between slices: record_file_tampered, every echo record in that part is metered, the run does not succeed", async () => {
    const { rig, cmdId } = await prepare();
    expect((await rig.slice(cmdId, rig.store, { maxRecords: 3 })).kind).toBe("slice");
    expect(rig.store.total).toBe(10);
    rig.vm.setFile(SLICE_REC, hidden(11)); // the consumed prefix changed (same length, so the offset still falls on a record)
    const r = await rig.slice(cmdId, rig.store);
    expect(r.kind).toBe("ended");
    expect(rig.flags).toContain("record_file_tampered");
    expect(rig.flags).toContain("record_mismatch");
    expect(rig.store.total).toBe(3010); // the full echo is metered
    expect(rig.store.delivered).toContain("m2*"); // the hidden record of the consumed part: meter-only
    expect(rig.store.delivered).not.toContain("m2");
    if (r.kind === "ended") expect(r.event).toMatchObject({ type: "error", isError: true });
  });

  it("a record file that cannot be read again at the exit is an unreadable cross-check: reader_unavailable and a run that did not succeed", async () => {
    const stuck = { reread: false };
    const rig = sliceRig({
      script: stream,
      vm: { readFilter: (data, ctx) => (stuck.reread && ctx.offset === 0 ? Buffer.alloc(0) : data) },
    });
    const cmdId = await rig.startCommand();
    expect((await rig.slice(cmdId, rig.store, { maxRecords: 3 })).kind).toBe("slice");
    stuck.reread = true; // only the read from the start fails: the exit's own re-read of the consumed part
    const r = await rig.slice(cmdId, rig.store);
    expect(r.kind).toBe("ended");
    expect(rig.flags).toContain("reader_unavailable");
    if (r.kind === "ended") expect(r.event).toMatchObject({ type: "error", isError: true });
  });

  it("a slice that restored nothing reads the file once from the start and never again: no re-read of a consumed part", async () => {
    const rig = sliceRig({ script: stream });
    const cmdId = await rig.startCommand();
    const first = await rig.slice(cmdId, rig.store, { maxRecords: 0 });
    expect(first.kind).toBe("slice");
    const r = await rig.slice(cmdId, rig.store);
    expect(r.kind).toBe("ended");
    expect(rig.vm.log.filter((e) => e.kind === "read" && e.offset === 0)).toHaveLength(1);
  });
});

describe("RLR-4 sanity of the rig itself", () => {
  it("the records the VM writes are the ones the parser accepts (header, lines, trailer)", async () => {
    const rig = sliceRig({ script: STREAM });
    await rig.startCommand();
    await new Promise((r) => setTimeout(r, 30));
    const acc = acceptRecords(rig.vm.file(SLICE_REC)!, 0);
    expect(acc.stop).toBeNull();
    expect(acc.records).toHaveLength(RECORDS);
    expect(RECORD_READ_CAP).toBeGreaterThan(0);
  });
});

// Keeps the type import used where a store type is named only in signatures.
export type { SliceStore };
void RunLimitError;
