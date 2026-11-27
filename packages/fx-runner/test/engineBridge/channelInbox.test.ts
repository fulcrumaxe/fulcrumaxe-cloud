import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EngineCommand } from "@fulcrumaxe/runner-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChannelInbox } from "../../src/engineBridge/channelInbox.js";
import { InboxRefused, type CommandInbox } from "../../src/engineBridge/inbox.js";
import { fakeGuest, type FakeGuest } from "../helpers/fakeGuestStreams.js";

const uid = process.getuid?.();
let dir: string;
let logs: string[];
let guest: FakeGuest;
let now: number;
beforeEach(() => {
  dir = path.join(mkdtempSync(path.join(tmpdir(), "fx-cinbox-")), "session");
  logs = [];
  guest = fakeGuest();
  now = Date.now();
});
afterEach(() => rmSync(path.dirname(dir), { recursive: true, force: true }));

const inbox = (): CommandInbox => createChannelInbox({ channel: guest.channel, dir, uid, now: () => now, log: (l) => logs.push(l) });
const command = (seq: number): EngineCommand => ({ v: 1, purpose: "engine-command", command_id: randomUUID(), command_seq: seq, runner_id: randomUUID(), repo_gh_id: 77, kind: "pause_loop", args: {}, issued_by: randomUUID(), issued_at: new Date(now).toISOString(), expires_at: new Date(now + 600_000).toISOString(), halt_epoch: 0 }) as unknown as EngineCommand;
const signed = (c: EngineCommand): unknown => ({ command: c, key_id: "k", signature: "s".repeat(86) });
const outcome = (c: EngineCommand, ack: unknown): string => `${JSON.stringify({ name: `${c.command_seq}-${c.command_id}`, ack })}\n`;

describe("a verified command goes into the guest as the cloud signed it", () => {
  it("forwards the signed bytes exactly, names the command, and lists it as waiting until its outcome is read", async () => {
    const box = inbox();
    const c = command(4);
    const body = signed(c);
    expect(await box.write(c, body)).toBe(`4-${c.command_id}`);
    expect(guest.commands).toEqual([body]);
    expect(guest.far.requests.map((q) => q.header["op"])).toEqual(["command"]);
    const waiting = await box.waiting();
    expect(waiting).toEqual([{ name: `4-${c.command_id}`, commandId: c.command_id, expiresMs: Date.parse(c.expires_at), mtimeMs: now }]);
  });

  it("a guest that names another command, or a channel that fails, is a failed write: nothing is recorded as written", async () => {
    const box = inbox();
    const c = command(1);
    guest.nameFor = () => `9-${randomUUID()}`;
    await expect(box.write(c, signed(c))).rejects.toThrow();
    guest.nameFor = undefined;
    guest.down = true;
    await expect(box.write(c, signed(c))).rejects.toThrow();
    expect(await box.waiting()).toEqual([]);
  });

  it("keeps the replay state in its own directory, 0600, and nothing else of the command", async () => {
    const box = inbox();
    box.saveState({ repos: { "77": 4 }, seen: { [randomUUID()]: now } });
    expect(box.loadState(now).repos).toEqual({ "77": 4 });
    expect(statSync(path.join(dir, "engine-commands-state.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe("outcomes come back through the outcomes stream and stay owed until their ack is settled", () => {
  it("reads outcomes, drops the command from waiting, and a restart reads the unsettled ones again from the saved offset", async () => {
    const [a, b] = [command(1), command(2)];
    const box = inbox();
    await box.write(a, signed(a));
    await box.write(b, signed(b));
    // the puller records every forwarded id as seen, which is what a restarted inbox knows it forwarded
    box.saveState({ repos: { "77": 2 }, seen: { [a.command_id]: now, [b.command_id]: now } });
    guest.append("outcomes", outcome(a, { outcome: "applied" }) + outcome(b, { outcome: "refused", refusal: "halted" }));
    const got = await box.consumed();
    expect(got.map((x) => [x.name, x.commandId, x.ack])).toEqual([
      [`1-${a.command_id}`, a.command_id, { outcome: "applied" }],
      [`2-${b.command_id}`, b.command_id, { outcome: "refused", refusal: "halted" }],
    ]);
    expect(guest.reads.at(-1)).toEqual({ after: 0, stream: "outcomes" });
    expect(await box.waiting()).toEqual([]);
    await box.settle(got[0]!.name, got[0]!.ack);
    expect((await box.consumed()).map((x) => x.name)).toEqual([`2-${b.command_id}`]);
    // the offset moved past the settled first outcome only
    expect(JSON.parse(readFileSync(path.join(dir, "outcomes-offset.json"), "utf8")).offset).toBe(Buffer.byteLength(outcome(a, { outcome: "applied" })));
    const restarted = inbox();
    expect((await restarted.consumed()).map((x) => x.name)).toEqual([`2-${b.command_id}`]);
    expect(guest.reads.at(-1)).toEqual({ after: Buffer.byteLength(outcome(a, { outcome: "applied" })), stream: "outcomes" });
    await restarted.settle(got[1]!.name, got[1]!.ack);
    expect(await restarted.consumed()).toEqual([]);
  });

  it("passes over lines that are not an outcome, a name that is not `<seq>-<uuid>` and an ack the protocol does not know", async () => {
    const box = inbox();
    const c = command(3);
    await box.write(c, signed(c));
    guest.append("outcomes", `not json\n${JSON.stringify({ name: "../x", ack: { outcome: "applied" } })}\n${JSON.stringify({ name: `3-${c.command_id}`, ack: { outcome: "exploded" } })}\n${outcome(c, { outcome: "applied" })}`);
    expect((await box.consumed()).map((x) => x.name)).toEqual([`3-${c.command_id}`]);
  });

  it("an outcome for a name this runner never forwarded is not relayed (and the offset still moves past it), however well formed", async () => {
    const box = inbox();
    const [ours, stranger] = [command(1), command(2)];
    await box.write(ours, signed(ours));
    guest.append("outcomes", outcome(stranger, { outcome: "applied" }) + outcome(ours, { outcome: "applied" }));
    expect((await box.consumed()).map((x) => x.name)).toEqual([`1-${ours.command_id}`]);
    // a restart that knows only the replay state of `ours` still does not relay the stranger's
    const again = inbox();
    again.saveState({ repos: { "77": 1 }, seen: { [ours.command_id]: now } });
    guest.append("outcomes", outcome(command(3), { outcome: "applied" }));
    expect((await again.consumed()).map((x) => x.name)).toEqual([`1-${ours.command_id}`]);
  });

  it("an unreadable channel is no outcome and one fixed line", async () => {
    const box = inbox();
    guest.down = true;
    expect(await box.consumed()).toEqual([]);
    expect(await box.consumed()).toEqual([]);
    expect(logs).toEqual(["engine-inbox: an engine session's channel could not be read; trying again later"]);
  });
});

describe("the directories the replay state lives in are looked at, never followed", () => {
  const sessionsDir = (): string => path.dirname(dir);
  const refused = (reason: string): void => {
    let error: unknown;
    try {
      inbox();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InboxRefused);
    expect((error as InboxRefused).reason).toBe(reason);
  };

  it("a link in place of the session directory is refused, and nothing is written through it", () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), "fx-cinbox-else-"));
    try {
      symlinkSync(elsewhere, dir);
      refused("link");
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("a link in place of the sessions directory above it is refused", () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), "fx-cinbox-else-"));
    const parent = mkdtempSync(path.join(tmpdir(), "fx-cinbox-par-"));
    const original = dir;
    try {
      const sessions = path.join(parent, "sessions");
      symlinkSync(elsewhere, sessions);
      dir = path.join(sessions, "session");
      refused("link");
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      dir = original;
      rmSync(elsewhere, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("a directory open to group or others is refused, on the session directory and on the sessions directory", () => {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o770);
    refused("open_permissions");
    chmodSync(dir, 0o700);
    chmodSync(sessionsDir(), 0o755);
    refused("open_permissions");
    chmodSync(sessionsDir(), 0o700);
    expect(() => inbox()).not.toThrow();
  });

  it("a directory of another owner is refused", () => {
    mkdirSync(dir, { mode: 0o700 });
    const mine = process.getuid?.();
    expect(mine).toBeDefined();
    let error: unknown;
    try {
      createChannelInbox({ channel: guest.channel, dir, uid: (mine as number) + 1, now: () => now, log: () => undefined });
    } catch (e) {
      error = e;
    }
    expect((error as InboxRefused).reason).toBe("foreign_owner");
  });

  it("a name that is a file, not a directory, is refused", () => {
    writeFileSync(dir, "x");
    refused("not_directory");
  });

  it("a directory swapped for a link after the inbox was made is refused when the state is next used", () => {
    const box = inbox();
    const elsewhere = mkdtempSync(path.join(tmpdir(), "fx-cinbox-else-"));
    try {
      box.saveState({ repos: { "77": 1 }, seen: {} });
      renameSync(dir, `${dir}.moved`);
      symlinkSync(elsewhere, dir);
      expect(() => box.saveState({ repos: { "77": 2 }, seen: {} })).toThrow(InboxRefused);
      expect(() => box.loadState(now)).toThrow(InboxRefused);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
