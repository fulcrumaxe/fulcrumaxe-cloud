import { describe, expect, it } from "vitest";
import { createUsageMeter } from "../src/meteringGuard.js";
import { STATE_MAX_BYTES, TAIL_STATE_MAX_BYTES, buildReaderState, jsonbText, snapshotMeterLedger, tailStateBytes } from "../src/readerState.js";
import { READ_FAILURE_LIMIT } from "../src/vercelSandboxPort.js";
import type { RecordingVmOptions } from "./helpers/recorderSdk.js";
import { recordFile } from "./helpers/recorderSdk.js";
import { assistantLine, envelopeBlock, resultLine, sliceRig, SLICE_REC, SLICE_RUN, type SliceScript } from "./helpers/sliceRig.js";

/**
 * D#2 RLR-4: how a sliced run ends when the part of the record file an earlier slice consumed cannot be read again, when reads fail across slices, when the verdict
 * outgrows the state column, and while the exit sequence outlasts the lease.
 */
const userLine = (): string => JSON.stringify({ type: "user", message: { role: "user", content: "a tool answer" } }) + "\n";
const stream: SliceScript = { lines: [assistantLine("m1", 10), assistantLine("m2", 1000), assistantLine("m3", 2000), resultLine("done")] };
/** The file as the agent rewrote it ahead of the reader: m2's usage line replaced by a line with no usage. The recorder's own copy (the echo) keeps the truth. */
const hidden = (): Buffer => recordFile(SLICE_RUN, [assistantLine("m1", 10).trim(), userLine().trim(), assistantLine("m3", 2000).trim(), resultLine("done").trim()]);
const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("an earlier slice's part of the record file that cannot be read again is untrusted, never skipped", () => {
  /** The from-start read (the exit's rebuild of the consumed part) fails once `fail.on` is set; every other read is fine. */
  function failingRebuild(fail: { on: boolean }): RecordingVmOptions {
    const vm: RecordingVmOptions = {};
    vm.readFilter = (data, ctx) => {
      vm.readExit = fail.on && ctx.offset === 0 ? 1 : 0;
      return data;
    };
    return vm;
  }

  it("the normal exit still replays the echo: usage hidden in the file is metered, reader_unavailable is raised and the run does not succeed", async () => {
    const fail = { on: false };
    const rig = sliceRig({ script: stream, vm: failingRebuild(fail) });
    const cmdId = await rig.startCommand();
    await settle();
    rig.vm.setFile(SLICE_REC, hidden());
    expect((await rig.slice(cmdId, rig.store, { maxRecords: 3 })).kind).toBe("slice");
    fail.on = true;
    const r = await rig.slice(cmdId, rig.store);
    expect(rig.store.total).toBe(3010); // m2 comes from the echo
    expect(rig.flags).toContain("reader_unavailable");
    expect(r.kind).toBe("ended");
    expect(r.kind === "ended" && r.event?.type === "result" && r.event.isError !== true).toBe(false); // not a success
  });

  it("a reader fault in a later slice still replays the echo for the consumed part", async () => {
    const vm: RecordingVmOptions = {};
    const fail = { on: false };
    vm.readFilter = (data) => {
      vm.readExit = fail.on ? 1 : 0; // every read fails from the second slice on, the rebuild too
      return data;
    };
    const rig = sliceRig({ script: { ...stream, endless: true }, vm });
    const cmdId = await rig.startCommand();
    await settle();
    expect((await rig.slice(cmdId, rig.store, { maxRecords: 2 })).kind).toBe("slice"); // header and m1
    fail.on = true;
    const r = await rig.slice(cmdId, rig.store);
    expect(r.kind).toBe("rejected");
    expect(rig.store.total).toBe(3010);
    expect(rig.flags).toContain("reader_unavailable");
  });

  it("the runner's own enforcement end meters every echo record up to the last one consumed, through meterOnly, when the consumed part cannot be read again", async () => {
    const fail = { on: false };
    const rig = sliceRig({ script: stream, vm: failingRebuild(fail), stopAbove: 1500 });
    const cmdId = await rig.startCommand();
    await settle();
    rig.vm.setFile(SLICE_REC, hidden());
    expect((await rig.slice(cmdId, rig.store, { maxRecords: 3 })).kind).toBe("slice"); // header, m1, the line that replaced m2
    expect(rig.store.total).toBe(10);
    fail.on = true;
    const r = await rig.slice(cmdId, rig.store); // m3 crosses the spend rule: the run is killed
    expect(r.kind).toBe("rejected");
    expect(rig.store.total).toBe(3010); // the hidden m2 is counted after the kill
    expect(rig.store.delivered).toContain("m2*"); // by meterOnly: it killed nothing and stopped nothing
    expect(rig.store.delivered.filter((d) => !d.endsWith("*") && d === "m2")).toEqual([]);
    expect(rig.flags).toContain("reader_unavailable");
  });
});

describe("a streak of failed reads is carried from one slice to the next", () => {
  it("many short slices that each see one failed read end the run at the read-failure limit", async () => {
    const vm: RecordingVmOptions = {};
    const fail = { on: false };
    vm.readFilter = (data) => {
      vm.readExit = fail.on ? 1 : 0;
      return data;
    };
    const rig = sliceRig({ script: { lines: [assistantLine("m1", 10)], endless: true }, vm });
    const cmdId = await rig.startCommand();
    await settle();
    expect((await rig.slice(cmdId, rig.store, { maxRecords: 2 })).kind).toBe("slice");
    fail.on = true;
    const kinds: string[] = [];
    const saved: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await rig.slice(cmdId, rig.store, { untilMs: Date.now() + 30 });
      kinds.push(r.kind);
      saved.push(rig.store.cp?.readFailures ?? -1);
      if (r.kind !== "slice") break;
    }
    expect(kinds.at(-1)).toBe("rejected");
    expect(kinds.length).toBeLessThanOrEqual(READ_FAILURE_LIMIT + 1);
    expect(saved[0]).toBeGreaterThan(0); // the first short slice already left its failure behind
    expect(rig.flags).toContain("reader_unavailable");
  });

  it("a read that succeeds resets the streak, so failures spread thinly across slices never end the run", async () => {
    const vm: RecordingVmOptions = {};
    let reads = 0;
    vm.readFilter = (data) => {
      vm.readExit = ++reads % 2 === 0 ? 1 : 0; // every other read fails
      return data;
    };
    const rig = sliceRig({ script: { lines: [assistantLine("m1", 10)], endless: true }, vm });
    const cmdId = await rig.startCommand();
    await settle();
    for (let i = 0; i < 12; i++) expect((await rig.slice(cmdId, rig.store, { untilMs: Date.now() + 30 })).kind).toBe("slice");
    expect(rig.flags).not.toContain("reader_unavailable");
  });
});

describe("a verdict that outgrows the state column ends the run, measured the way jsonb prints it", () => {
  const verdictOf = (n: number): SliceScript => {
    const env = { verdict: "pass", n: Array.from({ length: n }, () => 1e300) };
    const text = "done\n<!-- AGENT_OUTPUT -->\n```json\n" + JSON.stringify(env) + "\n```\n<!-- /AGENT_OUTPUT -->";
    return { lines: [assistantLine("m1", 10, text), assistantLine("m2", 20), resultLine("done")] };
  };
  const meterLedger = () => snapshotMeterLedger({ meteredTokens: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }, modelTokens: new Map(), meterFlags: new Set(), cumulativeModelUsd: 0 });

  it("jsonb prints a 1e300 as 301 characters: the measure counts them, JSON.stringify would not", () => {
    const env = { n: Array.from({ length: 12_000 }, () => 1e300) };
    expect(JSON.stringify(env).length).toBeLessThan(TAIL_STATE_MAX_BYTES);
    expect(tailStateBytes(null, env)).toBeGreaterThan(STATE_MAX_BYTES);
    expect(tailStateBytes(null, { n: [1e300] })).toBe(Buffer.byteLength(jsonbText([null, { n: [1e300] }])));
  });

  it("an envelope of 1e300 values passes a JSON size check but not the state bound: every save would fail, so the run ends as reader_unavailable instead", async () => {
    const rig = sliceRig({ script: verdictOf(12_000) });
    const meter = createUsageMeter();
    let built = 0;
    const shape = await rig.sliced(() => 1, rig.store, {
      checkpointEveryMs: 0,
      // what the target's commit does first: the state document is built (and refuses a state over the column's limit)
      commit: async (c) => {
        buildReaderState({ usage: meter.snapshot(), guard: c.guard, ledger: meterLedger(), reader: c.reader });
        built++;
        rig.store.cp = JSON.parse(JSON.stringify(c));
        return true;
      },
    });
    expect(shape.outcome).toMatch(/^rejected/);
    expect(rig.flags).toContain("reader_unavailable");
    expect(built).toBeGreaterThan(0); // the last save (with no verdict in it) went through
    expect(rig.store.cp?.final).toBe(true);
  });

  it("the same envelope with the run read in one go has no state to outgrow: it ends", async () => {
    expect((await sliceRig({ script: verdictOf(12_000) }).inProcess()).outcome).toBe("ended");
  });

  it("a verdict that fits (large, but under the bound as jsonb prints it) is carried across slices and ends the run with its envelope", async () => {
    const script = verdictOf(250);
    const base = await sliceRig({ script }).inProcess();
    expect(base.outcome).toBe("ended");
    const rig = sliceRig({ script });
    const meter = createUsageMeter();
    const shape = await rig.sliced(() => 1, rig.store, {
      checkpointEveryMs: 0,
      commit: async (c) => {
        buildReaderState({ usage: meter.snapshot(), guard: c.guard, ledger: meterLedger(), reader: c.reader });
        rig.store.cp = JSON.parse(JSON.stringify(c));
        return true;
      },
    });
    expect(shape.outcome).toBe("ended");
    expect(rig.flags).not.toContain("reader_unavailable");
  });
});

describe("the exit sequence keeps the lease alive", () => {
  const twoSlices = async (renewEveryMs: number | undefined, renew: () => Promise<boolean>) => {
    const slow = { on: false };
    const vm: RecordingVmOptions = { readDelay: async (ctx) => (slow.on && ctx.offset === 0 ? settle(250) : undefined) }; // the exit's rebuild of the consumed part is slow
    const rig = sliceRig({ script: { lines: [assistantLine("m1", 10), resultLine(envelopeBlock("pass"))] }, vm });
    const cmdId = await rig.startCommand();
    await settle();
    expect((await rig.slice(cmdId, rig.store, { maxRecords: 3 })).kind).toBe("slice");
    slow.on = true;
    return { rig, last: await rig.slice(cmdId, rig.store, { renew, ...(renewEveryMs !== undefined && { renewEveryMs }) }) };
  };

  it("a slow exit renews the lease on a timer, and stops renewing once the slice is over", async () => {
    let calls = 0;
    const { last } = await twoSlices(30, async () => ++calls > 0);
    expect(last.kind).toBe("ended");
    expect(calls).toBeGreaterThanOrEqual(3);
    const atEnd = calls;
    await settle(150);
    expect(calls).toBe(atEnd);
  });

  it("no renewal while the slice is only reading: a slice that hands over renews nothing", async () => {
    let calls = 0;
    const rig = sliceRig({ script: { ...stream, endless: true } });
    const cmdId = await rig.startCommand();
    await settle();
    expect((await rig.slice(cmdId, rig.store, { maxRecords: 2, renew: async () => ++calls > 0, renewEveryMs: 10 })).kind).toBe("slice");
    expect(calls).toBe(0);
  });

  it("a renewal that fails does not break the exit: the last save is what is fenced", async () => {
    let calls = 0;
    const { last } = await twoSlices(30, async () => {
      calls++;
      throw new Error("database busy");
    });
    expect(calls).toBeGreaterThan(0);
    expect(last.kind).toBe("ended");
  });
});
