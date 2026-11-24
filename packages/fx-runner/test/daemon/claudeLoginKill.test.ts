import { describe, expect, it } from "vitest";
import { CLAUDE_KILL_GRACE_MS, killLoginTree, readProcessTable, type LoginKillPorts, type LoginProc } from "../../src/daemon/claudeLogin.js";

/** A process table the test controls, and a record of every signal in order. */
function world(initial: Array<LoginProc & { ppid: number }>) {
  let table = [...initial];
  const sent: string[] = [];
  const timers: Array<{ ms: number; fn: () => void }> = [];
  const reader = readProcessTable({
    pids: () => table.map((p) => p.pid),
    stat: (pid) => {
      const p = table.find((q) => q.pid === pid);
      // pid (name) state ppid pgrp session ... start time is the 20th field after the name
      return p === undefined ? undefined : `${p.pid} (we ird) name) S ${p.ppid} ${p.pgid} ${p.pgid} 0 -1 0 0 0 0 0 0 0 0 0 0 0 1 0 ${p.start} 1`;
    },
  });
  const ports: LoginKillPorts = { ...reader, signal: (t, sig) => void sent.push(`${sig} ${t}`), after: (ms, fn) => void timers.push({ ms, fn }) };
  return { ports, sent, timers, set: (next: Array<LoginProc & { ppid: number }>) => void (table = next) };
}
// script 100 leads group 100; it started the CLI shell 101 in a NEW session and group 101; the shell started helper 102 (same group 101); an unrelated process 900.
const TREE = [
  { pid: 100, ppid: 1, pgid: 100, start: "t100" },
  { pid: 101, ppid: 100, pgid: 101, start: "t101" },
  { pid: 102, ppid: 101, pgid: 101, start: "t102" },
  { pid: 900, ppid: 1, pgid: 900, start: "t900" },
];

describe("ending a sign-in's process tree", () => {
  it("reads the whole tree below the child, whatever the process name holds", () => {
    const w = world(TREE);
    expect(w.ports.below(100)).toEqual([
      { pid: 101, pgid: 101, start: "t101" },
      { pid: 102, pgid: 101, start: "t102" },
    ]);
    expect(w.ports.look(102)).toEqual({ pid: 102, pgid: 101, start: "t102" });
    expect(w.ports.look(5)).toBeUndefined();
  });

  it("terminates script's group AND the group the CLI was put in, at once, and kills what is left after the grace", () => {
    const w = world(TREE);
    killLoginTree(w.ports, 100);
    expect(w.sent).toEqual(["SIGTERM -100", "SIGTERM -101"]);
    expect(w.timers.map((t) => t.ms)).toEqual([CLAUDE_KILL_GRACE_MS]);
    w.timers[0]!.fn();
    // script's group, then the CLI's group and each process that is still the one that was seen; never the unrelated process
    expect(w.sent.slice(2)).toEqual(["SIGKILL -100", "SIGKILL -101", "SIGKILL 101", "SIGKILL -101", "SIGKILL 102"]);
    expect(w.sent.join(" ")).not.toContain("900");
  });

  it("sends no kill to a pid that has gone to another process in the meantime", () => {
    const w = world(TREE);
    killLoginTree(w.ports, 100);
    // 101 ended and its pid was taken by an unrelated process (new start time, other group); 102 is gone altogether; script's pid is also reused
    w.set([
      { pid: 100, ppid: 1, pgid: 4000, start: "reused" },
      { pid: 101, ppid: 1, pgid: 5000, start: "other" },
      { pid: 900, ppid: 1, pgid: 900, start: "t900" },
    ]);
    w.timers[0]!.fn();
    expect(w.sent).toEqual(["SIGTERM -100", "SIGTERM -101"]);
  });

  it("still kills script's group when script itself has gone but its group has members", () => {
    const w = world(TREE);
    killLoginTree(w.ports, 100);
    w.set([
      { pid: 101, ppid: 1, pgid: 101, start: "t101" },
      { pid: 102, ppid: 101, pgid: 101, start: "t102" },
    ]);
    w.timers[0]!.fn();
    expect(w.sent.slice(2)).toContain("SIGKILL -100");
    expect(w.sent.slice(2)).toContain("SIGKILL 101");
    expect(w.sent.slice(2)).toContain("SIGKILL 102");
  });

  it("a child that started something after the first look is found at the second", () => {
    const w = world(TREE.slice(0, 2));
    killLoginTree(w.ports, 100);
    w.set(TREE);
    w.timers[0]!.fn();
    expect(w.sent).toContain("SIGKILL 102");
  });

  it("a child with no pid-table entry (a start that failed) is still given the group signals and nothing else", () => {
    const w = world([]);
    killLoginTree(w.ports, 100);
    expect(w.sent).toEqual(["SIGTERM -100"]);
    w.timers[0]!.fn();
    expect(w.sent).toEqual(["SIGTERM -100", "SIGKILL -100"]);
  });
});
