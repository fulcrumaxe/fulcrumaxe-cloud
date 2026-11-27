import { describe, expect, it } from "vitest";
import { createSessionRegistry } from "../../src/engineSession/registry.js";
import { fakeChannel } from "../helpers/fakeChannel.js";
import { del, NAME, SESSION_REPO, sessionJob, sessionRig, start, stop, type Rig } from "./sessionRig.js";

/**
 * D#845 ON-14a (Ruling 120.2): the lifecycle fills the in-memory registry the bridge reads, with the signed job's own repository, job and version and the session's channel: on a start that ran its supervisor, and nowhere else.
 * The rig is the lifecycle's (ON-13b2): the signed jobs go through the real dispatcher and the strict job schema, and the supervisor is the stand-in of the channel's contract.
 */
const TOKEN = `fake-synthetic-${"t".repeat(24)}`;
const GONE_PID = 2_000_000_000;
const stopAnswer = { ok: true, survivors: 0, token_wiped: true, pid: GONE_PID };
const eventsAnswer = { ok: true, lines: [], ends: [], next: 0, reset: false };

function wired(over: (h: Record<string, unknown>) => unknown = () => undefined): Rig {
  const r = sessionRig();
  r.token = TOKEN;
  r.channel = fakeChannel((h) => over(h) ?? (h["op"] === "stop" ? stopAnswer : h["op"] === "events_read" ? eventsAnswer : { ok: true }));
  return r;
}
const withVersion = (atSha: string, version: string) => sessionJob("engine_session_start", { at_sha: atSha, resume: false, operate_epoch: 1, engine_version: version });

describe("a start registers its session", () => {
  it("registers the signed job's repository, job id and engine version once the start is done, with a working channel", async () => {
    const r = wired();
    const job = withVersion(r.repo.commit, "1.2.3");
    await r.run(job);
    const [entry, ...rest] = r.sessions.list();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ repo_gh_id: SESSION_REPO, job_id: job.job_id, engine_version: "1.2.3", fresh: true });
    expect(await entry!.channel.eventsRead(0, "engine")).toEqual({ lines: [], ends: [], next: 0, reset: false });
    expect((r.channel as NonNullable<Rig["channel"]>).requests.at(-1)?.header).toEqual({ op: "events_read", after: 0, stream: "engine" });
  });

  it("a start whose job carries no version registers one with none (the bridge then refuses it with a closed word)", async () => {
    const r = wired();
    await r.run(start(r.repo.commit, false));
    expect(r.sessions.list()).toMatchObject([{ repo_gh_id: SESSION_REPO, engine_version: undefined, fresh: true }]);
  });

  it("a resumed start is not fresh: the disk and its files are the ones the saved cursors were made for", async () => {
    const r = wired();
    await r.run(start(r.repo.commit, false));
    await r.run(stop());
    expect(r.sessions.list()).toEqual([]);
    await r.run(start(r.repo.commit, true));
    expect(r.sessions.list()).toMatchObject([{ fresh: false }]);
  });

  it("a start that does not reach done, or has no supervisor to read, leaves nothing registered, and clears an older entry of the repository", async () => {
    const r = wired((h) => (h["op"] === "token_put" ? { ok: false, code: "bad_request" } : undefined));
    r.sessions.register({ repo_gh_id: SESSION_REPO, job_id: "older", engine_version: "1.0.0", fresh: false, channel: {} as never });
    await r.run(start(r.repo.commit, false));
    expect(r.sessions.list()).toEqual([]);
    const plain = sessionRig(); // no credential source: no supervisor, so nothing for the bridge to read
    plain.channel = fakeChannel(() => ({ ok: true }));
    await plain.run(start(plain.repo.commit, false));
    expect(plain.sessions.list()).toEqual([]);
  });
});

describe("a stop or a delete clears it first", () => {
  it("clears the session before anything is asked of the guest, so the bridge stops reading a session that is going down", async () => {
    const r = wired();
    await r.run(start(r.repo.commit, false));
    expect(r.sessions.list()).toHaveLength(1);
    const seenAtStop: number[] = [];
    r.channel = fakeChannel((h) => {
      if (h["op"] === "stop") seenAtStop.push(r.sessions.list().length);
      return h["op"] === "stop" ? stopAnswer : { ok: true };
    });
    await r.run(stop());
    expect(seenAtStop).toEqual([0]);
    expect(r.sessions.list()).toEqual([]);
  });

  it("a delete clears it, and a stop for a session that is not up leaves the registry as it was", async () => {
    const r = wired();
    await r.run(start(r.repo.commit, false));
    await r.run(del());
    expect(r.sessions.list()).toEqual([]);
    expect(r.machines.has(NAME)).toBe(false);
    await r.run(stop(2));
    expect(r.sessions.list()).toEqual([]);
  });
});

describe("the registry", () => {
  it("keeps one entry per repository, and a late clear of an older job never removes a newer one", () => {
    const sessions = createSessionRegistry();
    const base = { repo_gh_id: 1, engine_version: "1.2.3", fresh: true, channel: {} as never };
    sessions.register({ ...base, job_id: "a" });
    sessions.register({ ...base, job_id: "b" });
    expect(sessions.list().map((e) => e.job_id)).toEqual(["b"]);
    sessions.clear(1, "a");
    expect(sessions.list().map((e) => e.job_id)).toEqual(["b"]);
    sessions.clear(1, "b");
    expect(sessions.list()).toEqual([]);
    sessions.register({ ...base, job_id: "c" });
    sessions.clear(1);
    expect(sessions.list()).toEqual([]);
  });
});
