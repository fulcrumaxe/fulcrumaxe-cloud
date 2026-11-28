import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fakeChannel, type FakeChannel } from "../helpers/fakeChannel.js";
import { RUNNER_ID } from "../helpers/machineJobFixture.js";
import { NAME, compactSession, sessionRig, start, stop, type Rig } from "./sessionRig.js";

/**
 * D#845 ON-13b2: the session lifecycle with the channel: the credential goes in over it, the host is started with a tick, and every stop sends the channel `stop` BEFORE the VM is touched. The supervisor on the far end is a
 * stand-in built to the channel's own contract (`helpers/fakeChannel.ts`), the VM factory and the guest are the lifecycle rig's, and the token is an obviously synthetic string.
 */
const TOKEN = `fake-synthetic-${"t".repeat(24)}`;
const START_STEPS = ["admission:started", "admission:ok", "session_create:started", "session_create:ok", "seed:started", "seed:ok", "session_boot:started", "session_boot:ok"];
const WITH_HOST = [...START_STEPS, "credentials:started", "credentials:ok", "supervisor:started", "supervisor:ok", "done:ok@created"];

/** A pid no guest has (above any pid limit): the supervisor program is gone as soon as it is looked for. */
const GONE_PID = 2_000_000_000;
const stopAnswer = (over: Record<string, unknown> = {}) => ({ ok: true, survivors: 0, token_wiped: true, pid: GONE_PID, ...over });
/** Answers the runner's look at the supervisor program (`kill -0` in the guest's shell, exit 0 while it is there, 1 once gone): `present(n)` says whether the n-th look (from 1) still finds it. Returns the arguments of every look. */
type Look = boolean | "denied" | "missing_shell" | "unrecognised" | "hangs";
const LOOK_SCRIPT: Record<string, string> = {
  there: "exit 0",
  gone: 'echo "sh: 1: kill: No such process" >&2; exit 1',
  denied: 'echo "sh: 1: kill: Operation not permitted" >&2; exit 1',
  missing_shell: "exit 127",
  unrecognised: 'echo "something else" >&2; exit 1',
  hangs: "sleep 5",
};
function lookAtProgram(r: Rig, answer: (look: number) => Look): string[][] {
  const looks: string[][] = [];
  const guest = r.machines.get(NAME)!.guest.guest as unknown as { runCommand: (p: { cmd: string; args?: string[] }) => Promise<unknown> };
  const real = guest.runCommand.bind(guest);
  guest.runCommand = (p) => {
    if (p.cmd !== "sh" || !(p.args?.[1] ?? "").startsWith("kill -0 ")) return real(p);
    looks.push(p.args ?? []);
    const said = answer(looks.length);
    return real({ cmd: "sh", args: ["-c", LOOK_SCRIPT[said === true ? "there" : said === false ? "gone" : said]!] });
  };
  return looks;
}
function wired(answers: (header: Record<string, unknown>) => unknown = () => ({ ok: true })): { r: Rig; channel: FakeChannel } {
  const r = sessionRig();
  r.token = TOKEN;
  const channel = fakeChannel((header) => {
    r.log.push(`channel ${String(header["op"])}`);
    return answers(header);
  });
  r.channel = channel;
  return { r, channel };
}
const ops = (c: FakeChannel): string[] => c.requests.map((q) => String(q.header["op"]));

describe("a start with the channel", () => {
  it("hands the credential in (the bytes, once), writes the session config for the guest, and starts the host with the first tick", async () => {
    const { r, channel } = wired();
    await r.run(start(r.repo.commit, false));
    expect(compactSession(r.reports)).toEqual(WITH_HOST);
    expect(ops(channel)).toEqual(["token_put", "tick"]);
    expect(channel.requests[0]?.header).toEqual({ op: "token_put", name: "claude", size: TOKEN.length });
    expect(channel.requests[0]?.body?.toString("latin1")).toBe(TOKEN);
    expect(channel.requests[1]?.header).toEqual({ op: "tick", kind: "loop" });
    expect(r.issued).toHaveLength(1);
    expect(r.issued[0]?.every((b) => b === 0), "the runner's copy of the credential is zeroed after the send").toBe(true);
    const machine = r.machines.get(NAME)!;
    const config = JSON.parse(readFileSync(path.join(machine.root, "sandbox", ".fx-engine", "session.json"), "utf8")) as Record<string, unknown>;
    expect(config).toEqual({ repo_gh_id: "77", repo_checkout: machine.guest.paths.workspace, runner_id: RUNNER_ID, cloud_origin: "https://cloud.fictional.invalid" });
    expect(JSON.stringify(r.reports)).not.toContain(TOKEN);
    expect(r.log.join("\n")).not.toContain(TOKEN);
  });

  it("a credential the guest refuses ends the start at `credentials` with the one closed code, ends the VM it made, and zeroes the buffer", async () => {
    const { r, channel } = wired((h) => (h["op"] === "token_put" ? { ok: false, code: "bad_request" } : { ok: true }));
    await r.run(start(r.repo.commit, false));
    expect(compactSession(r.reports).slice(-2)).toEqual(["credentials:started", "credentials:failed:vm_token_delivery_failed"]);
    expect(ops(channel)).toEqual(["token_put"]);
    expect(r.issued[0]?.every((b) => b === 0)).toBe(true);
    expect(r.machines.has(NAME)).toBe(false); // the VM this start made is ended, not left running with nothing in it
  });

  it("no credential source (or no channel) means no credentials or supervisor step, as before", async () => {
    const r = sessionRig();
    r.channel = fakeChannel(() => ({ ok: true }));
    await r.run(start(r.repo.commit, false)); // a channel but no token source
    expect(compactSession(r.reports)).toEqual([...START_STEPS, "done:ok@created"]);
    expect(r.channel.requests).toEqual([]);
  });

  it("a first tick the guest refuses (no config, a refusal of the supervisor) ends the start at `supervisor`", async () => {
    const { r } = wired((h) => (h["op"] === "tick" ? { ok: false, code: "refused", reason: "halted" } : { ok: true }));
    await r.run(start(r.repo.commit, false));
    expect(compactSession(r.reports).slice(-2)).toEqual(["supervisor:started", "supervisor:failed:vm_boot_failed/supervisor"]);
  });

  it("a woken session whose start fails after the credential went in gets a channel stop before its snapshot", async () => {
    const { r, channel } = wired((h) => (h["op"] === "stop" ? stopAnswer() : { ok: true }));
    await r.run(start(r.repo.commit, false));
    await r.run(stop());
    r.reports.length = 0;
    r.log.length = 0;
    channel.requests.length = 0;
    const failing = fakeChannel((h) => (h["op"] === "tick" ? { ok: false, code: "refused" } : h["op"] === "stop" ? stopAnswer() : { ok: true }));
    r.channel = failing;
    await r.run(start(r.repo.commit, true));
    expect(compactSession(r.reports).at(-1)).toBe("supervisor:failed:vm_boot_failed/supervisor");
    expect(ops(failing)).toEqual(["token_put", "tick", "stop"]);
    expect(failing.requests.at(-1)?.header).toEqual({ op: "stop", reason: "machine_shutdown" });
    expect(r.log.indexOf(`stop ${NAME}`)).toBeGreaterThan(-1);
  });

  describe("a woken start that fails while the guest may hold the credential ends the VM with NO snapshot", () => {
    const cases: Array<[string, (h: Record<string, unknown>) => unknown]> = [
      ["a channel that stays silent", () => { throw new Error("the peer went away"); }],
      ["a credential the guest did not confirm wiped", () => stopAnswer({ token_wiped: false })],
      ["a survivor of the host's tree", () => stopAnswer({ survivors: 1 })],
      ["a reply with no pid", () => stopAnswer({ pid: undefined })],
    ];
    for (const [what, answer] of cases) {
      it(what, async () => {
        const { r } = wired((h) => (h["op"] === "stop" ? stopAnswer() : { ok: true }));
        await r.run(start(r.repo.commit, false));
        await r.run(stop());
        const kept = r.snapshots.get(NAME);
        r.reports.length = 0;
        r.log.length = 0;
        r.channel = fakeChannel((h) => (h["op"] === "tick" ? { ok: false, code: "refused" } : h["op"] === "stop" ? answer(h) : { ok: true }));
        await r.run(start(r.repo.commit, true));
        expect(compactSession(r.reports).at(-1)).toBe("supervisor:failed:vm_boot_failed/supervisor");
        expect(r.log, what).toContain(`destroy ${NAME}`);
        expect(r.log, what).not.toContain(`stop ${NAME}`);
        expect(r.snapshots.get(NAME), `${what}: the snapshot it woke from is kept, no new one`).toBe(kept);
        expect(r.registry.get(NAME)?.state, what).toBe("stopped");
      });
    }

    it("a supervisor program that is still there after the wait", async () => {
      const { r } = wired((h) => (h["op"] === "stop" ? stopAnswer() : { ok: true }));
      await r.run(start(r.repo.commit, false));
      await r.run(stop());
      const kept = r.snapshots.get(NAME);
      r.log.length = 0;
      r.channel = fakeChannel((h) => (h["op"] === "tick" ? { ok: false, code: "refused" } : h["op"] === "stop" ? stopAnswer({ pid: 4242 }) : { ok: true }));
      const looks = lookAtProgram(r, () => true);
      await r.run(start(r.repo.commit, true));
      expect(looks.length).toBeGreaterThan(1);
      expect(looks[0]).toEqual(["-c", "kill -0 4242"]);
      expect(r.log).toContain(`destroy ${NAME}`);
      expect(r.log).not.toContain(`stop ${NAME}`);
      expect(r.snapshots.get(NAME)).toBe(kept);
    });

    it("a supervisor program that exits within the wait still gets its snapshot", async () => {
      const { r } = wired((h) => (h["op"] === "stop" ? stopAnswer() : { ok: true }));
      await r.run(start(r.repo.commit, false));
      await r.run(stop());
      const kept = r.snapshots.get(NAME) ?? 0;
      r.log.length = 0;
      r.channel = fakeChannel((h) => (h["op"] === "tick" ? { ok: false, code: "refused" } : h["op"] === "stop" ? stopAnswer({ pid: 4242 }) : { ok: true }));
      const looks = lookAtProgram(r, (n) => n < 3);
      await r.run(start(r.repo.commit, true));
      expect(looks).toHaveLength(3);
      expect(r.log).toContain(`stop ${NAME}`);
      expect(r.log).not.toContain(`destroy ${NAME}`);
      expect(r.snapshots.get(NAME)).toBe(kept + 1);
    });
  });
});

describe("a stop with the channel", () => {
  it("sends the channel stop first, wipes before anything else touches the VM, syncs the guest, and reports how it ended", async () => {
    const { r, channel } = wired((h) => (h["op"] === "stop" ? stopAnswer() : { ok: true }));
    await r.run(start(r.repo.commit, false));
    r.reports.length = 0;
    r.log.length = 0;
    channel.requests.length = 0;
    await r.run(stop());
    expect(compactSession(r.reports)).toEqual(["admission:started", "admission:ok", "session_stop:started", "session_stop:ok", "snapshot:started", "snapshot:ok", "done:ok"]);
    expect(channel.requests.map((q) => q.header)).toEqual([{ op: "stop", reason: "stopped_by_person" }]);
    const order = r.log.filter((l) => l === "channel stop" || l === `quiesce ${NAME}` || l === `stop ${NAME}`);
    expect(order).toEqual(["channel stop", `quiesce ${NAME}`, `stop ${NAME}`]);
    expect(r.machines.get(NAME)?.guest.sent.commands.map((c) => c.cmd)).toContain("sync");
    expect(r.stopReports).toEqual([{ repo_gh_id: 77, job_id: r.reports[0]?.["job_id"], reason: "person", method: "vm_stop", survivors: 0, paused: { synced: true } }]);
  });

  it("each of the cloud's reasons is the supervisor's own word, so the host's stop event says which: a halt is `halted`", async () => {
    for (const [reason, word] of [["person", "stopped_by_person"], ["halt", "halted"], ["operate_off", "operate_off"], ["plan", "machine_shutdown"], ["move", "machine_shutdown"], ["remove", "machine_shutdown"]] as const) {
      const { r, channel } = wired((h) => (h["op"] === "stop" ? stopAnswer() : { ok: true }));
      await r.run(start(r.repo.commit, false));
      channel.requests.length = 0;
      await r.run(stop(1, reason));
      expect(channel.requests.map((q) => q.header), reason).toEqual([{ op: "stop", reason: word }]);
    }
  });

  it("a halt ends the VM through vm_stop with no survivor, and the report says so", async () => {
    const { r } = wired((h) => (h["op"] === "stop" ? stopAnswer() : { ok: true }));
    await r.run(start(r.repo.commit, false));
    await r.run(stop(1, "halt"));
    expect(r.machines.get(NAME)?.state).toBe("stopped");
    expect(r.stopReports).toMatchObject([{ reason: "halt", method: "vm_stop", survivors: 0 }]);
  });

  it("the unit tier reports `unit`, and nothing was synced (there is no guest disk to flush)", async () => {
    const r = sessionRig();
    r.tier = "unit";
    await r.run(start(r.repo.commit, false));
    await r.run(stop(1, "halt"));
    expect(r.stopReports).toMatchObject([{ reason: "halt", method: "unit", survivors: 0, paused: { synced: false } }]);
  });

  it("a survivor, a credential that was not wiped, or a channel that does not answer fails the stop closed: nothing is snapshotted and nothing is reported", async () => {
    const cases: Array<[string, (h: Record<string, unknown>) => unknown, string]> = [
      ["survivor", () => stopAnswer({ survivors: 1 }), "session_stop:failed:vm_teardown_incomplete/survivors"],
      ["not wiped", () => stopAnswer({ token_wiped: false }), "session_stop:failed:vm_teardown_incomplete/channel"],
      ["refused", () => ({ ok: false, code: "internal" }), "session_stop:failed:vm_teardown_incomplete/channel"],
    ];
    for (const [what, answer, report] of cases) {
      const { r } = wired((h) => (h["op"] === "stop" ? answer(h) : { ok: true }));
      await r.run(start(r.repo.commit, false));
      r.reports.length = 0;
      r.log.length = 0;
      await r.run(stop());
      expect(compactSession(r.reports).at(-1), what).toBe(report);
      expect(r.log.some((l) => l === `stop ${NAME}` || l === `quiesce ${NAME}`), `${what}: the VM was not touched`).toBe(false);
      expect(r.stopReports, what).toEqual([]);
      expect(r.machines.get(NAME)?.state, what).toBe("running");
    }
    const { r } = wired((h) => {
      if (h["op"] === "stop") throw new Error("the peer went away");
      return { ok: true };
    });
    await r.run(start(r.repo.commit, false));
    r.reports.length = 0;
    await r.run(stop());
    expect(compactSession(r.reports).at(-1)).toBe("session_stop:failed:vm_teardown_incomplete/channel");
  });

  describe("a stop waits for the old supervisor program to be gone before the VM is touched", () => {
    it("exits in time: the stop looks at the pid the reply named, and only then quiesces, syncs and snapshots", async () => {
      const { r } = wired((h) => (h["op"] === "stop" ? stopAnswer({ pid: 4242 }) : { ok: true }));
      await r.run(start(r.repo.commit, false));
      const looks = lookAtProgram(r, (n) => n < 3); // there for two looks, gone on the third
      r.reports.length = 0;
      r.log.length = 0;
      await r.run(stop());
      expect(looks).toEqual([["-c", "kill -0 4242"], ["-c", "kill -0 4242"], ["-c", "kill -0 4242"]]);
      expect(compactSession(r.reports).at(-1)).toBe("done:ok");
      expect(r.log.filter((l) => l === "channel stop" || l === `quiesce ${NAME}` || l === `stop ${NAME}`)).toEqual(["channel stop", `quiesce ${NAME}`, `stop ${NAME}`]);
      expect(r.stopReports).toHaveLength(1);
    });

    it("never exits: no quiesce and no snapshot, the VM is ended without one (earlier snapshots kept), and nothing is reported as stopped", async () => {
      const { r } = wired((h) => (h["op"] === "stop" ? stopAnswer({ pid: 4242 }) : { ok: true }));
      await r.run(start(r.repo.commit, false));
      const looks = lookAtProgram(r, () => true);
      r.reports.length = 0;
      r.log.length = 0;
      await r.run(stop());
      expect(looks.length).toBeGreaterThan(1);
      expect(compactSession(r.reports).at(-1)).toBe("session_stop:failed:vm_teardown_incomplete/exit");
      expect(r.log).not.toContain(`stop ${NAME}`);
      expect(r.log).not.toContain(`quiesce ${NAME}`);
      expect(r.log).toContain(`destroy ${NAME}`);
      expect(r.snapshots.get(NAME) ?? 0).toBe(0);
      expect(r.stopReports).toEqual([]);
    });

    it("a reply with no pid is not confirmed: no look is made, no snapshot, the VM is ended", async () => {
      const { r } = wired((h) => (h["op"] === "stop" ? stopAnswer({ pid: undefined }) : { ok: true }));
      await r.run(start(r.repo.commit, false));
      const looks = lookAtProgram(r, () => false);
      r.reports.length = 0;
      r.log.length = 0;
      await r.run(stop());
      expect(looks).toEqual([]);
      expect(compactSession(r.reports).at(-1)).toBe("session_stop:failed:vm_teardown_incomplete/exit");
      expect(r.log).not.toContain(`stop ${NAME}`);
      expect(r.log).toContain(`destroy ${NAME}`);
    });
  });

  describe("a look that does not say `No such process` never counts as gone (an exit 1 for `Operation not permitted` is a live process of another user)", () => {
    const looks: Look[] = ["denied", "missing_shell", "unrecognised", "hangs"];
    for (const said of looks) {
      it(`stop: ${said} ends the VM with no snapshot`, async () => {
        const { r } = wired((h) => (h["op"] === "stop" ? stopAnswer({ pid: 4242 }) : { ok: true }));
        await r.run(start(r.repo.commit, false));
        lookAtProgram(r, () => said);
        r.reports.length = 0;
        r.log.length = 0;
        await r.run(stop());
        expect(compactSession(r.reports).at(-1)).toBe("session_stop:failed:vm_teardown_incomplete/exit");
        expect(r.log).toContain(`destroy ${NAME}`);
        expect(r.log).not.toContain(`stop ${NAME}`);
        expect(r.log).not.toContain(`quiesce ${NAME}`);
        expect(r.snapshots.get(NAME) ?? 0).toBe(0);
      });
      it(`woken start: ${said} ends the VM with no snapshot`, async () => {
        const { r } = wired((h) => (h["op"] === "stop" ? stopAnswer() : { ok: true }));
        await r.run(start(r.repo.commit, false));
        await r.run(stop());
        const kept = r.snapshots.get(NAME);
        r.log.length = 0;
        r.channel = fakeChannel((h) => (h["op"] === "tick" ? { ok: false, code: "refused" } : h["op"] === "stop" ? stopAnswer({ pid: 4242 }) : { ok: true }));
        lookAtProgram(r, () => said);
        await r.run(start(r.repo.commit, true));
        expect(r.log).toContain(`destroy ${NAME}`);
        expect(r.log).not.toContain(`stop ${NAME}`);
        expect(r.snapshots.get(NAME)).toBe(kept);
      });
    }
  });

  describe("a halt or an operate-off whose channel stop fails ends the VM with no snapshot", () => {
    for (const reason of ["halt", "operate_off"] as const) {
      for (const [what, answer] of [["silent", () => { throw new Error("gone"); }], ["not wiped", () => stopAnswer({ token_wiped: false })], ["a survivor", () => stopAnswer({ survivors: 2 })]] as Array<[string, () => unknown]>) {
        it(`${reason}, ${what}`, async () => {
          const { r } = wired((h) => (h["op"] === "stop" ? answer() : { ok: true }));
          await r.run(start(r.repo.commit, false));
          r.reports.length = 0;
          r.log.length = 0;
          await r.run(stop(1, reason));
          expect(compactSession(r.reports).at(-1)).toMatch(/^session_stop:failed:vm_teardown_incomplete\//);
          expect(r.log).toContain(`destroy ${NAME}`);
          expect(r.log).not.toContain(`stop ${NAME}`);
          expect(r.log).not.toContain(`quiesce ${NAME}`);
          expect(r.snapshots.get(NAME) ?? 0).toBe(0);
          expect(r.stopReports).toEqual([]);
        });
      }
    }
  });

  it("a person's stop whose channel is dead because the daemon's snapshot write timed out ends the VM with the no-snapshot teardown, without quiesce or sync, and ends the session stopped", async () => {
    const { r } = wired((h) => (h["op"] === "stop" ? { ok: false, code: "internal" } : { ok: true }));
    await r.run(start(r.repo.commit, false));
    r.reports.length = 0;
    r.log.length = 0;
    r.writeTimedOut.add(NAME);
    await r.run(stop());
    expect(compactSession(r.reports)).toEqual(["admission:started", "admission:ok", "session_stop:started", "session_stop:ok", "snapshot:started", "snapshot:ok", "done:ok"]);
    expect(r.log.filter((l) => l === `quiesce ${NAME}` || l === `stop ${NAME}` || l === `destroy ${NAME}`)).toEqual([`destroy ${NAME}`]); // never a stop: nothing here can snapshot
    expect(r.snapshots.get(NAME) ?? 0).toBe(0);
    expect(r.machines.has(NAME)).toBe(false);
  });

  it("the timed-out-write path is taken only for a channel failure: a survivor or a supervisor that did not exit keeps its own handling", async () => {
    const cases: Array<[string, () => unknown, string]> = [
      ["survivor", () => stopAnswer({ survivors: 1 }), "session_stop:failed:vm_teardown_incomplete/survivors"],
      ["no pid", () => stopAnswer({ pid: undefined }), "session_stop:failed:vm_teardown_incomplete/exit"],
    ];
    for (const [what, answer, report] of cases) {
      const { r } = wired((h) => (h["op"] === "stop" ? answer() : { ok: true }));
      await r.run(start(r.repo.commit, false));
      r.reports.length = 0;
      r.log.length = 0;
      r.writeTimedOut.add(NAME);
      await r.run(stop());
      expect(compactSession(r.reports).at(-1), what).toBe(report);
      expect(r.stopReports, what).toEqual([]);
    }
  });

  it("the same dead channel without a timed-out write still fails the stop closed and leaves the VM up", async () => {
    const { r } = wired((h) => (h["op"] === "stop" ? { ok: false, code: "internal" } : { ok: true }));
    await r.run(start(r.repo.commit, false));
    r.reports.length = 0;
    await r.run(stop());
    expect(compactSession(r.reports).at(-1)).toBe("session_stop:failed:vm_teardown_incomplete/channel");
    expect(r.machines.get(NAME)?.state).toBe("running");
  });

  it("a stop of a VM that is not running does not dial the channel, and reports nothing", async () => {
    const { r, channel } = wired((h) => (h["op"] === "stop" ? stopAnswer() : { ok: true }));
    await r.run(start(r.repo.commit, false));
    await r.run(stop());
    channel.requests.length = 0;
    const dials = channel.connections();
    r.stopReports.length = 0;
    await r.run(stop(2));
    expect(channel.connections()).toBe(dials);
    expect(r.stopReports).toEqual([]);
  });

  it("a guest that cannot sync reports `synced: false`, and the stop still ends well", async () => {
    const { r } = wired((h) => (h["op"] === "stop" ? stopAnswer() : { ok: true }));
    await r.run(start(r.repo.commit, false));
    const guest = r.machines.get(NAME)!.guest.guest as unknown as { runCommand: (p: { cmd: string; args?: string[] }) => Promise<unknown> };
    const real = guest.runCommand.bind(guest);
    guest.runCommand = (p) => real(p.cmd === "sync" ? { cmd: "sh", args: ["-c", "exit 3"] } : p);
    await r.run(stop());
    expect(r.stopReports).toMatchObject([{ method: "vm_stop", survivors: 0, paused: { synced: false } }]);
  });
});
