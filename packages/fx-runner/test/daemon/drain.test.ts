import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drainCommand } from "../../src/commands/drain.js";
import { LEDGER_FILE } from "../../src/commands/run.js";
import type { CommandContext } from "../../src/context.js";
import type { Admission, Snapshot } from "../../src/daemon/admission.js";
import type { ClaimResult } from "../../src/daemon/client.js";
import { pollLoop, type PollEvent } from "../../src/daemon/pollLoop.js";
import { DRAIN_FILE, isDraining, setDraining } from "../../src/runnerSettings.js";
import { instantClock } from "../helpers/manualClock.js";
import { OPEN_GATE } from "../helpers/openGate.js";
import { signedJob } from "../helpers/signedJob.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-drain-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signed = signedJob();
const claimed: ClaimResult = { kind: "claimed", signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 };

describe("the poll loop under a drain", () => {
  it("with a job in hand it claims nothing more and ends once that job has ended", async () => {
    const controller = new AbortController();
    let draining = false;
    let ended = false;
    let claims = 0;
    const client = {
      async claim(): Promise<ClaimResult> {
        claims += 1;
        return claimed;
      },
    };
    // The person asks for the drain while the first job runs; the job ends a moment later. No second claim may follow.
    const onClaimed = async (): Promise<void> => {
      draining = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      ended = true;
    };
    const end = await pollLoop({ client, clock: instantClock(), gate: OPEN_GATE, signal: controller.signal, draining: () => draining, onClaimed });
    expect(end).toBe("drained");
    expect(ended).toBe(true);
    expect(claims).toBe(1);
  });

  it("with nothing in hand it ends before any claim", async () => {
    const controller = new AbortController();
    let claims = 0;
    const client = { async claim(): Promise<ClaimResult> { claims += 1; return { kind: "idle", retryAfter: 1 }; } };
    const end = await pollLoop({ client, clock: instantClock(), gate: OPEN_GATE, signal: controller.signal, draining: () => true, onClaimed: async () => undefined });
    expect(end).toBe("drained");
    expect(claims).toBe(0);
  });

  it("the held line is marked near only for the one-job-at-a-time warning", async () => {
    const controller = new AbortController();
    const log: PollEvent[] = [];
    const snap = (near: boolean): Snapshot => ({ capacity: { light: { limit: 1, in_use: 1 }, heavy: { limit: 0, in_use: 0 }, limited_by: "usage_limit" }, limits: { light: "usage_limit", heavy: "usage_limit" }, free: { light: 0, heavy: 0 }, limitedBy: "usage_limit", usageNear: near });
    const snaps = [snap(true), snap(false)];
    const admission = { snapshot: () => snaps.shift() ?? snap(false), classOf: () => "light" } as unknown as Admission;
    let claims = 0;
    const client = { async claim(): Promise<ClaimResult> { claims += 1; if (claims > 2) controller.abort(); return { kind: "idle", retryAfter: 1 }; } };
    await pollLoop({ client, clock: instantClock(), gate: OPEN_GATE, signal: controller.signal, admission, onClaimed: async () => undefined, log: (e) => log.push(e) });
    const held = log.filter((e) => e.event === "held");
    expect(held[0]).toEqual({ event: "held", light: "usage_limit", heavy: "usage_limit", near: true });
    expect(held[1]).toEqual({ event: "held", light: "usage_limit", heavy: "usage_limit" });
  });
});

describe("fx-runner drain", () => {
  const ctxFor = (lines: string[]): CommandContext => ({ stateDir: dir, out: (l) => lines.push(l), err: (l) => lines.push(l), now: () => new Date(), fetchFn: fetch });

  it("with no runner on the state directory it writes nothing and exits 0", async () => {
    const lines: string[] = [];
    expect(await drainCommand(ctxFor(lines), process.kill, { wait: true })).toBe(0);
    expect(isDraining(dir)).toBe(false);
    expect(lines.join("\n")).toContain("nothing to drain");
  });

  it("a lock whose process is gone counts as no runner", async () => {
    writeFileSync(path.join(dir, `${LEDGER_FILE}.lock`), "2147483000\n");
    const lines: string[] = [];
    expect(await drainCommand(ctxFor(lines), () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }, { wait: true })).toBe(0);
    expect(isDraining(dir)).toBe(false);
  });

  it("a real process holding the lock: the marker is written, the command waits for its exit, then removes the marker and returns 0", async () => {
    // A stand-in daemon in its own process: it drains the way the real one does, by exiting 0 when it sees the marker.
    const marker = path.join(dir, DRAIN_FILE);
    const script = `const fs=require("fs");const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(t);process.exit(0);}},20);`;
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      writeFileSync(path.join(dir, `${LEDGER_FILE}.lock`), `${String(child.pid)}\n`);
      const lines: string[] = [];
      const code = await drainCommand(ctxFor(lines), process.kill, { wait: true, pollMs: 20 });
      expect(code).toBe(0);
      expect(await exited).toBe(0);
      expect(isDraining(dir)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(lines.join("\n")).toContain("safe to upgrade");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("--no-wait only writes the marker", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
    try {
      writeFileSync(path.join(dir, `${LEDGER_FILE}.lock`), `${String(child.pid)}\n`);
      const lines: string[] = [];
      expect(await drainCommand(ctxFor(lines), process.kill, { wait: false })).toBe(0);
      expect(isDraining(dir)).toBe(true);
      setDraining(dir, false);
      expect(isDraining(dir)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
