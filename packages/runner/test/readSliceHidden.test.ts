import { describe, expect, it } from "vitest";
import { acceptRecords } from "../src/recordParser.js";
import { assistantLine, resultLine, sliceRig, SLICE_RUN, type RunShape } from "./helpers/sliceRig.js";
import { recordFile, type RecordingVm } from "./helpers/recorderSdk.js";

/**
 * D#2 RLR-4: usage that is missing from the (agent-writable) record file but present in the recorder's echo is metered however the run is cut into
 * slices -- after a reader fault, a runner limit, a spend rule, and with a stray line in the echo. Each case runs unsliced, a boundary after every record,
 * and a boundary after every two.
 */
const plans: Array<[string, (i: number) => number | undefined]> = [
  ["in one slice", () => undefined],
  ["a boundary after every record", () => 1],
  ["a boundary after every two records", () => 2],
];

/** The file with the middle of the usage taken out, no trailer (the file is only ever replaced once the first four records are in). */
const withoutTrailer = (lines: string[]): Buffer => {
  const full = recordFile(SLICE_RUN, lines);
  return full.subarray(0, full.lastIndexOf(0x0a, full.length - 2) + 1);
};

const filler = Array.from({ length: 24 }, (_, i) => assistantLine(`x${i}`, 1).trim());

describe.each(plans)("RLR-4 hidden usage is metered %s", (_label, plan) => {
  it("a reader fault still runs the echo cross-check: the file shrinks under the reader, and the echo's usage is metered", async () => {
    let step = 0;
    const rig = sliceRig({
      script: { lines: [assistantLine("m1", 10), assistantLine("m2", 1000), assistantLine("m3", 2000)], endless: true },
      vm: {
        onRead: (path, v) => {
          const f = v.file(path);
          if (!f) return;
          if (step === 0 && acceptRecords(f, 0).records.length >= 4) {
            step = 1;
            v.setFile(path, withoutTrailer([assistantLine("m1", 10).trim()]));
          } else if (step === 1) {
            step = 2;
            v.setFile(path, Buffer.alloc(0));
          }
        },
      },
    });
    const r: RunShape = await rig.sliced(plan);
    expect(r.outcome).toMatch(/^rejected:/);
    expect(r.total).toBe(3010);
    expect(r.flags).toContain("record_file_tampered");
  });

  it("a stray line in the echo does not stop the cross-check from reading the records after it", async () => {
    let swapped = false;
    const rig = sliceRig({
      script: { lines: [assistantLine("m1", 10), assistantLine("m2", 1000), assistantLine("m3", 2000), resultLine("done")] },
      afterStart: (vm: RecordingVm) => vm.agents[0]!.feed.push("stdout", "a stray line in the echo\n"),
      vm: {
        onRead: (path, v) => {
          const f = v.file(path);
          if (!f || swapped || !acceptRecords(f, 0).trailer) return;
          swapped = true;
          v.setFile(path, recordFile(SLICE_RUN, [assistantLine("m1", 10).trim(), resultLine("done").trim()]));
        },
      },
    });
    const r = await rig.sliced(plan);
    expect(swapped).toBe(true);
    expect(r.total).toBe(3010);
    expect(r.flags).toContain("record_mismatch");
  });

  it("a stray line in the echo together with a reader fault", async () => {
    let step = 0;
    const rig = sliceRig({
      script: { lines: [assistantLine("m1", 10), assistantLine("m2", 1000), assistantLine("m3", 2000)], endless: true },
      afterStart: (vm: RecordingVm) => vm.agents[0]!.feed.push("stdout", "junk line\n"),
      vm: {
        onRead: (path, v) => {
          const f = v.file(path);
          if (!f) return;
          if (step === 0 && acceptRecords(f, 0).records.length >= 4) {
            step = 1;
            v.setFile(path, withoutTrailer([assistantLine("m1", 10).trim()]));
          } else if (step === 1) {
            step = 2;
            v.setFile(path, Buffer.alloc(0));
          }
        },
      },
    });
    expect((await rig.sliced(plan)).total).toBe(3010);
  });

  it("a runner limit ends the run with usage hidden before it: the hidden usage is metered and the end stays the limit", async () => {
    let step = 0;
    const rig = sliceRig({
      script: { lines: [assistantLine("m1", 10), assistantLine("m2", 1000), assistantLine("m3", 2000)], endless: true },
      limits: { maxModelCalls: 20 },
      vm: {
        onRead: (path, v) => {
          const f = v.file(path);
          if (!f || step !== 0 || acceptRecords(f, 0).records.length < 4) return;
          step = 1;
          v.setFile(path, withoutTrailer([assistantLine("m1", 10).trim(), ...filler]));
        },
      },
    });
    const r = await rig.sliced(plan);
    expect(r.outcome).toBe("rejected:RunLimitError:model_calls");
    expect(r.total).toBeGreaterThanOrEqual(3010);
    expect(r.flags).toContain("record_mismatch");
    // The hidden usage is counted as meter-only: nothing of it is delivered as an event the run acts on.
    expect(r.delivered.filter((d) => d === "m2" || d === "m3")).toEqual([]);
  });

  it("the same limit end with the hidden usage crossing the caller's spend rule: the end is still the limit, and the usage is still counted", async () => {
    let step = 0;
    const rig = sliceRig({
      script: { lines: [assistantLine("m1", 10), assistantLine("m2", 1000), assistantLine("m3", 2000)], endless: true },
      limits: { maxModelCalls: 20 },
      stopAbove: 500,
      vm: {
        onRead: (path, v) => {
          const f = v.file(path);
          if (!f || step !== 0 || acceptRecords(f, 0).records.length < 4) return;
          step = 1;
          v.setFile(path, withoutTrailer([assistantLine("m1", 10).trim(), ...filler]));
        },
      },
    });
    const r = await rig.sliced(plan);
    expect(r.outcome).toBe("rejected:RunLimitError:model_calls");
    expect(r.total).toBeGreaterThanOrEqual(3010);
  });
});
