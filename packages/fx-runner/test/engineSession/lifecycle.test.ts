import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SESSION_FAILURE_CODES, SESSION_JOB_STEPS, SESSION_START_MODES, SessionJobProgressBody, SETUP_FAILURE_REASON_PATTERN } from "@fulcrumaxe/runner-protocol";
import { describe, expect, it } from "vitest";
import { sessionNameOf, SESSION_VM_LIMIT_MS } from "../../src/engineSession/lifecycle.js";
import { engineSessionPolicy } from "../../src/engineSession/sessionPolicy.js";
import { git } from "../vm/workspace/helpers.js";
import { NAME, SESSION_REPO, compactSession, del, inventoryOk, sessionRig, start, stop, GIB } from "./sessionRig.js";

/** D#845 ON-13a1: the session lifecycle on the microVM tier, through the real dispatcher, the real operate mark and real workspace unpack on directory-backed guests. */
const FRESH_STEPS = ["admission:started", "admission:ok", "session_create:started", "session_create:ok", "seed:started", "seed:ok", "session_boot:started", "session_boot:ok"];

describe("a start", () => {
  it("resume false creates one persistent VM named by the repository id, puts the six-host policy in force before the first guest command, seeds at_sha and ends at done with `created`", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    expect(compactSession(r.reports)).toEqual([...FRESH_STEPS, "done:ok@created"]);
    expect(r.reports.map((x) => x["seq"])).toEqual(r.reports.map((_, i) => i));
    expect([...r.machines.keys()]).toEqual([NAME]);
    expect(NAME).toBe(sessionNameOf(SESSION_REPO));
    expect(r.factoryOptions).toEqual([{ timeoutMs: SESSION_VM_LIMIT_MS, runId: r.reports[0]?.["job_id"], persistent: true }]);
    const calls = r.log.filter((l) => l.startsWith("guest.") || l.startsWith("create"));
    expect(calls[0]).toBe(`create ${NAME}`);
    expect(calls[1]).toBe(`guest.updateNetworkPolicy ${NAME}`); // before any command or file
    expect(calls.slice(2).every((l) => l.startsWith("guest.writeFiles") || l.startsWith("guest.runCommand"))).toBe(true);
    const machine = r.machines.get(NAME)!;
    expect(machine.guest.sent.policies).toEqual([engineSessionPolicy()]);
    expect(git(machine.guest.paths.workspace, "rev-parse", "HEAD")).toBe(r.repo.commit);
    expect(r.registry.get(NAME)?.state).toBe("running"); // the session outlives the job
    expect(r.events.map((e) => e.event)).toEqual(["ended"]);
  });

  it("every report is protocol-valid, and none carries anything but closed words", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    for (const report of r.reports) {
      const body = Object.fromEntries(Object.entries(report).filter(([key]) => key !== "job_id"));
      expect(SessionJobProgressBody.safeParse(body).success).toBe(true);
    }
  });

  it("resume true with the disk kept reports `resumed`, skips the seed, sends nothing into the guest, and the file written before the stop is still there (B-3)", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    const machine = r.machines.get(NAME)!;
    writeFileSync(path.join(machine.guest.paths.workspace, "kept-by-b3.txt"), "written before the stop\n");
    await r.run(stop());
    expect(r.machines.get(NAME)?.state).toBe("stopped");
    const before = r.log.length;
    r.reports.length = 0;
    await r.run(start(r.repo.commit, true));
    expect(compactSession(r.reports)).toEqual(["admission:started", "admission:ok", "session_create:started", "session_create:ok", "seed:skipped", "session_boot:started", "session_boot:ok", "done:ok@resumed"]);
    expect(readFileSync(path.join(machine.guest.paths.workspace, "kept-by-b3.txt"), "utf8")).toBe("written before the stop\n");
    const after = r.log.slice(before);
    expect(after).toContain(`resume ${NAME}`);
    expect(after.some((l) => l.startsWith("create") || l.startsWith("repos.open"))).toBe(false);
    // the closed policy is put in force again on the woken guest (a woken VM starts closed)
    expect(after.indexOf(`guest.updateNetworkPolicy ${NAME}`)).toBeGreaterThan(after.indexOf(`resume ${NAME}`));
    expect(r.machines.get(NAME)?.state).toBe("running");
  });

  it("a runner restart with the VM still up: resume true takes it into the port (a wake), so a later stop really stops it", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    r.restart(); // the process forgets what it held; the VM is still running
    expect(r.machines.get(NAME)?.state).toBe("running");
    const before = r.log.length;
    r.reports.length = 0;
    await r.run(start(r.repo.commit, true));
    expect(compactSession(r.reports).at(-1)).toBe("done:ok@resumed");
    expect(r.log.slice(before)).toContain(`resume ${NAME}`);
    r.reports.length = 0;
    await r.run(stop());
    expect(compactSession(r.reports).at(-1)).toBe("done:ok");
    expect(r.machines.get(NAME)?.state).toBe("stopped");
    expect(r.snapshots.get(NAME)).toBe(1);
  });

  it("resume true after the VM and its disk were evicted takes the fresh path: seed ok, `fresh`, and the working copy's HEAD is at_sha", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    await r.run(stop());
    r.evict(NAME);
    r.reports.length = 0;
    await r.run(start(r.repo.commit, true));
    expect(compactSession(r.reports)).toEqual([...FRESH_STEPS, "done:ok@fresh"]);
    const machine = r.machines.get(NAME)!;
    expect(git(machine.guest.paths.workspace, "rev-parse", "HEAD")).toBe(r.repo.commit);
    expect(r.log.filter((l) => l.startsWith("repos.open"))).toHaveLength(2);
  });

  it("a wake that answers SandboxNotFoundError (the disk went between the state read and the wake) takes the fresh path too", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    await r.run(stop());
    r.evict(NAME);
    r.lie.set(NAME, "stopped");
    r.reports.length = 0;
    await r.run(start(r.repo.commit, true));
    expect(compactSession(r.reports).at(-1)).toBe("done:ok@fresh");
    expect(r.log).toContain(`resume ${NAME}`);
    expect(r.log.filter((l) => l === `create ${NAME}`)).toHaveLength(2);
  });

  it("resume false replaces what the name kept: the old sandbox and its snapshot are deleted first, and the old file is gone", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    const old = r.machines.get(NAME)!;
    writeFileSync(path.join(old.guest.paths.workspace, "old.txt"), "x");
    await r.run(stop());
    expect(r.snapshots.get(NAME)).toBe(1);
    r.reports.length = 0;
    await r.run(start(r.repo.commit, false));
    expect(compactSession(r.reports).at(-1)).toBe("done:ok@created");
    expect(r.snapshots.has(NAME)).toBe(false);
    expect(existsSync(path.join(r.machines.get(NAME)!.guest.paths.workspace, "old.txt"))).toBe(false);
  });

  it("a state that cannot be read ends the start vm_boot_failed on session_create and creates nothing", async () => {
    const r = sessionRig();
    r.lie.set(NAME, "unknown");
    await r.run(start(r.repo.commit, true));
    expect(compactSession(r.reports).at(-1)).toBe("session_create:failed:vm_boot_failed/state");
    expect(r.log.filter((l) => l.startsWith("create"))).toEqual([]);
  });
});

describe("a start that cannot finish leaves nothing running", () => {
  it("a repository this machine never set up ends the seed vm_workspace_failed/repo, ends the new VM and clears the table", async () => {
    const r = sessionRig();
    r.fail.repoOf = true;
    await r.run(start(r.repo.commit, false));
    expect(compactSession(r.reports).at(-1)).toBe("seed:failed:vm_workspace_failed/repo");
    expect(r.machines.size).toBe(0);
    expect(r.registry.ids()).toEqual([]);
    expect(r.log).toContain(`delete ${NAME}`);
  });

  it("a mirror that cannot be brought up to date ends the seed the same way, and the host copy is released", async () => {
    const r = sessionRig();
    r.fail.repoOpen = true;
    await r.run(start(r.repo.commit, false));
    expect(compactSession(r.reports).at(-1)).toBe("seed:failed:vm_workspace_failed/repo");
    expect(r.machines.size).toBe(0);
  });

  it("a VM that cannot be made ends session_create vm_boot_failed (nothing is left in the table)", async () => {
    const r = sessionRig();
    r.fail.create = true;
    await r.run(start(r.repo.commit, false));
    expect(compactSession(r.reports).at(-1)).toBe("session_create:failed:vm_boot_failed");
    expect(r.registry.ids()).toEqual([]);
  });
});

describe("admission", () => {
  it("a second engine on the machine is refused machine_single_project, with nothing created, and a stopped one does not count", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false, 1, { repo_gh_id: 5 }));
    const before = r.log.length;
    r.reports.length = 0;
    await r.run(start(r.repo.commit, false));
    expect(compactSession(r.reports)).toEqual(["admission:started", "admission:failed:machine_single_project"]);
    expect(r.log.slice(before).filter((l) => l.startsWith("create") || l.startsWith("resume") || l.startsWith("delete"))).toEqual([]);
    // the first engine stops: its memory is free and the second may start (never queued, so it is a new job)
    await r.run(stop(1, "person", { repo_gh_id: 5 }));
    r.reports.length = 0;
    await r.run(start(r.repo.commit, false));
    expect(compactSession(r.reports).at(-1)).toBe("done:ok@created");
  });

  it("a host with too little memory is refused vm_memory_low, never queued, and nothing is created; a smaller template does not lower the 4 GiB floor", async () => {
    const r = sessionRig();
    r.freeBytes.value = 4 * GIB; // needs 4096 MiB for the guest and 1 GiB of headroom
    await r.run(start(r.repo.commit, false));
    expect(compactSession(r.reports)).toEqual(["admission:started", "admission:failed:vm_memory_low"]);
    expect(r.log.filter((l) => l.startsWith("create"))).toEqual([]);
    r.freeBytes.value = 5 * GIB + 1;
    r.reports.length = 0;
    await r.run(start(r.repo.commit, false));
    expect(compactSession(r.reports).at(-1)).toBe("done:ok@created");
  });

  it("a memory table that cannot be read refuses vm_memory_low too", async () => {
    const r = sessionRig();
    r.freeBytes.value = Number.NaN;
    await r.run(start(r.repo.commit, false));
    expect(compactSession(r.reports).at(-1)).toBe("admission:failed:vm_memory_low");
  });
});

describe("the operate mark", () => {
  it("a start below the mark is refused operate_stale with zero port calls; an equal epoch passes; a stop at e+1 then a start at e is stale", async () => {
    const r = sessionRig();
    await r.run(stop(5)); // raises the mark to 5; nothing is up, so it ends done
    expect(compactSession(r.reports)).toEqual(["admission:started", "admission:ok", "session_stop:skipped", "snapshot:skipped", "done:ok"]);
    r.reports.length = 0;
    await r.run(start(r.repo.commit, false, 4));
    expect(compactSession(r.reports)).toEqual(["admission:started", "admission:failed:operate_stale"]);
    expect(r.log).toEqual([]);
    expect(r.factoryOptions).toHaveLength(2); // the factory is asked for, but no VM call is made
    r.reports.length = 0;
    await r.run(start(r.repo.commit, false, 5));
    expect(compactSession(r.reports).at(-1)).toBe("done:ok@created");
  });

  it("a stop or a delete is never refused for being stale", async () => {
    const r = sessionRig();
    await r.run(stop(9));
    r.reports.length = 0;
    await r.run(stop(2), del(1));
    expect(compactSession(r.reports).filter((x) => x.includes("failed"))).toEqual([]);
    expect(compactSession(r.reports).filter((x) => x === "done:ok")).toHaveLength(2);
  });

  it("the mark rises on a start and survives a restart (every run builds the dispatcher and the mark anew over the same state directory)", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false, 7));
    r.reports.length = 0;
    await r.run(stop(), start(r.repo.commit, false, 6));
    expect(compactSession(r.reports).at(-1)).toBe("admission:failed:operate_stale");
    expect(r.makeDeps().mark.observe("0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10", 0)).toEqual({ ok: true, prior: 7 });
  });
});

describe("a stop", () => {
  it("ends the agent, stops the VM with a snapshot, frees its memory in the table and ends at done", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    r.reports.length = 0;
    await r.run(stop());
    expect(compactSession(r.reports)).toEqual(["admission:started", "admission:ok", "session_stop:started", "session_stop:ok", "snapshot:started", "snapshot:ok", "done:ok"]);
    expect(r.log.filter((l) => /^(quiesce|stop|releaseEgress)/.test(l)).slice(-3)).toEqual([`quiesce ${NAME}`, `stop ${NAME}`, `releaseEgress ${NAME}`]);
    expect(r.snapshots.get(NAME)).toBe(1);
    expect(r.registry.get(NAME)?.state).toBe("stopped");
    expect(r.registry.running()).toEqual([]);
  });

  it("a snapshot that cannot be taken ends snapshot_failed, and the VM is not reported stopped", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    r.reports.length = 0;
    r.fail.stop = true;
    await r.run(stop());
    expect(compactSession(r.reports).at(-1)).toBe("snapshot:failed:snapshot_failed");
    expect(r.registry.get(NAME)?.state).toBe("running");
  });

  it("a stop the port did not act on (the VM is still up afterwards) ends snapshot_failed, not ok", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    r.restart(); // the port holds nothing now: its stop is a silent no-op
    r.reports.length = 0;
    await r.run(stop());
    expect(compactSession(r.reports).at(-1)).toBe("snapshot:failed:snapshot_failed/state");
    expect(r.machines.get(NAME)?.state).toBe("running");
  });

  it("a state that cannot be read ends the stop session_stop vm_teardown_incomplete and touches nothing", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    r.lie.set(NAME, "unknown");
    r.reports.length = 0;
    const before = r.log.length;
    await r.run(stop());
    expect(compactSession(r.reports).at(-1)).toBe("session_stop:failed:vm_teardown_incomplete/state");
    expect(r.log.slice(before).filter((l) => /^(quiesce|stop|releaseEgress)/.test(l))).toEqual([]);
  });

  it("a stop of a session that is already stopped, or was never kept, skips both steps and ends done", async () => {
    const r = sessionRig();
    await r.run(stop());
    expect(compactSession(r.reports)).toEqual(["admission:started", "admission:ok", "session_stop:skipped", "snapshot:skipped", "done:ok"]);
  });

  it("after a start's done, a stop delivered next is taken at once (the start's job slot was freed by its done)", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false), stop());
    const ids = [...new Set(r.reports.map((x) => x["job_id"]))];
    expect(ids).toHaveLength(2);
    expect(compactSession(r.reports.filter((x) => x["job_id"] === ids[1])).at(-1)).toBe("done:ok");
    expect(r.machines.get(NAME)?.state).toBe("stopped");
  });
});

describe("a delete", () => {
  it("leaves nothing: no VM, no snapshot, no inventory row and no table entry for the name", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    await r.run(stop());
    expect(r.inventory().map((x) => x.name)).toEqual([NAME]);
    expect(r.inventory()[0]?.snapshot_count).toBe(1);
    r.reports.length = 0;
    await r.run(del());
    expect(compactSession(r.reports)).toEqual(["admission:started", "admission:ok", "session_delete:started", "session_delete:ok", "done:ok"]);
    expect(r.inventory()).toEqual([]);
    expect(r.machines.size).toBe(0);
    expect(r.snapshots.size).toBe(0);
    expect(r.registry.ids()).toEqual([]);
    expect(r.log.filter((l) => /^(releaseEgress|delete)/.test(l)).slice(-2)).toEqual([`releaseEgress ${NAME}`, `delete ${NAME}`]);
  });

  it("a delete the daemon says it did, while the name is still held, is not reported ok", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    r.reports.length = 0;
    r.lie.set(NAME, "stopped");
    await r.run(del());
    expect(compactSession(r.reports).at(-1)).toBe("session_delete:failed:vm_teardown_incomplete");
  });

  it("a delete that cannot finish ends session_delete vm_teardown_incomplete and keeps the name in the table as a leftover", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false));
    r.reports.length = 0;
    r.fail.delete = true;
    await r.run(del());
    expect(compactSession(r.reports).at(-1)).toBe("session_delete:failed:vm_teardown_incomplete");
    expect(r.registry.leftovers()).toEqual([NAME]);
  });
});

describe("facts are ids, enums and integers only", () => {
  it("the inventory of a session sandbox passes the B-7 schema, and every name, report and call carries only closed words and the sandbox's id", async () => {
    const r = sessionRig();
    await r.run(start(r.repo.commit, false), stop(), start(r.repo.commit, true), stop(), del());
    await r.run(start(r.repo.commit, false, 1, { repo_gh_id: 5 }));
    expect(inventoryOk(r.inventory())).toBe(true);
    expect(r.inventory().map((x) => x.name)).toEqual([sessionNameOf(5)]);
    const steps = new Set<string>(SESSION_JOB_STEPS);
    const states = new Set(["started", "ok", "failed", "skipped"]);
    const codes = new Set<string>(SESSION_FAILURE_CODES);
    for (const report of r.reports) {
      expect(Object.keys(report).sort().every((k) => ["job_id", "seq", "step", "state", "failure_code", "failure_reason", "start_mode"].includes(k))).toBe(true);
      expect(steps.has(String(report["step"])) && states.has(String(report["state"]))).toBe(true);
      if (report["failure_code"] !== undefined) expect(codes.has(String(report["failure_code"]))).toBe(true);
      if (report["failure_reason"] !== undefined) expect(SETUP_FAILURE_REASON_PATTERN.test(String(report["failure_reason"]))).toBe(true);
      if (report["start_mode"] !== undefined) expect((SESSION_START_MODES as readonly string[]).includes(String(report["start_mode"]))).toBe(true);
    }
    for (const line of r.log) expect(/^(create|resume|startEgress|waitGuest|releaseEgress|stop|destroy|delete|quiesce) fx-engine-\d+$|^guest\.\w+ fx-engine-\d+$|^repos\.(open \d+ (at_sha|other)|release)$/.test(line), line).toBe(true);
    expect(r.events.every((e) => e.event === "ended")).toBe(true);
  });
});
