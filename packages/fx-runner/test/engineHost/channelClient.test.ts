import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Duplex, duplexPair } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { guestRuntime } from "../../scripts/engine-supervise-host.mjs";
import { ChannelError, createChannelClient } from "../../src/engineHost/channelClient.js";
import { createGuestSession, FRAME_MAX, SESSION_CONFIG_FILE, TOKEN_MAX, type GuestSession } from "../../src/engineHost/guestSession.js";
import { fakeChannel } from "../helpers/fakeChannel.js";
import { unixSocketsRefused } from "../helpers/needsHostSockets.js";
import { tempDir } from "../helpers/tempTree.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#845 ON-13b2: the runner's client of the engine session's channel. The far end is the stand-in built to the channel's contract (`helpers/fakeChannel.ts`) and, in the last test, the REAL session over a real unix socket
 * with a stand-in host (no model, a PRIVATE PATH). The dial of the real VM (vsock port 5255) is the real-VM test's.
 */
const TOKEN = `fake-synthetic-${"c".repeat(24)}`;
const expectCode = async (work: Promise<unknown>, code: string): Promise<void> => {
  const error = await work.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ChannelError);
  expect((error as ChannelError).code).toBe(code);
};

describe("requests", () => {
  it("each operation is one frame in the contract's shape, and its answer is read from the one reply frame", async () => {
    const far = fakeChannel((h) => {
      switch (h["op"]) {
        case "tick":
          return { ok: true, started: true };
        case "command":
          return { ok: true, name: "7-abc" };
        case "stop":
          return { ok: true, survivors: 0, token_wiped: true, pid: 321 };
        case "events_read":
          return { ok: true, lines: ["{}"], next: 3, reset: false };
        default:
          return { ok: true };
      }
    });
    const client = createChannelClient(far.connect);
    expect(await client.tick("loop")).toEqual({ started: true });
    expect(await client.tick("checkin", "pm-sweep")).toEqual({ started: true });
    expect(await client.command({ any: "signed" })).toBe("7-abc");
    expect(await client.stop("halted")).toEqual({ survivors: 0, tokenWiped: true, pid: 321 });
    expect(await client.eventsRead(0)).toEqual({ lines: ["{}"], next: 3, reset: false });
    expect(await client.eventsRead(3, "outcomes")).toEqual({ lines: ["{}"], next: 3, reset: false });
    await client.tokenPut(Buffer.from(TOKEN));
    await client.tokenPut(Buffer.from("ghs_x"), "github");
    expect(far.requests.map((q) => q.header)).toEqual([
      { op: "tick", kind: "loop" },
      { op: "tick", kind: "checkin", name: "pm-sweep" },
      { op: "command", command: { any: "signed" } },
      { op: "stop", reason: "halted" },
      { op: "events_read", after: 0 },
      { op: "events_read", after: 3, stream: "outcomes" },
      { op: "token_put", name: "claude", size: TOKEN.length },
      { op: "token_put", name: "github", size: 5 },
    ]);
    expect(far.requests.at(-1)?.body?.toString()).toBe("ghs_x");
    expect(far.requests.at(-2)?.body?.toString()).toBe(TOKEN);
    expect(far.connections()).toBe(8); // one request per connection
  });

  it("a refusal is its closed code, and nothing of the peer's text is kept", async () => {
    const far = fakeChannel(() => ({ ok: false, code: "command_unverified", reason: "secret detail" }));
    const error = await createChannelClient(far.connect).command({}).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect(JSON.stringify(error)).not.toContain("secret detail");
    expect((error as ChannelError).message).not.toContain("secret detail");
  });

  it("a dial that fails is `unreachable`, a peer that says nothing or something that is not a reply is `bad_reply`, and one that never answers is `timeout` (and its connection is closed)", async () => {
    await expectCode(createChannelClient(() => Promise.reject(new Error("/some/path refused"))).tick("loop"), "unreachable");
    await expectCode(createChannelClient(fakeChannel(() => { throw new Error("gone"); }).connect).tick("loop"), "bad_reply");
    await expectCode(createChannelClient(fakeChannel(() => ["not", "a", "reply"]).connect).tick("loop"), "bad_reply");
    await expectCode(createChannelClient(fakeChannel(() => ({ ok: true, survivors: -1, token_wiped: true })).connect).stop("halted"), "bad_reply");
    const [client, server] = duplexPair();
    await expectCode(createChannelClient(async () => client, { timeoutMs: 40 }).tick("loop"), "timeout");
    expect(client.destroyed).toBe(true);
    server.destroy();
  });

  it("a stop reply's pid is a number above 1, and anything else is no pid (the caller then does not confirm the program is gone)", async () => {
    for (const pid of ["12", -4, 0, 1, 1.5, null]) {
      expect(await createChannelClient(fakeChannel(() => ({ ok: true, survivors: 0, token_wiped: true, pid })).connect).stop("halted")).toEqual({ survivors: 0, tokenWiped: true, pid: undefined });
    }
    expect(await createChannelClient(fakeChannel(() => ({ ok: true, survivors: 0, token_wiped: true })).connect).stop("halted")).toMatchObject({ pid: undefined });
  });

  it("a guest that streams without end is dropped with `bad_reply` once past one frame: memory stays bounded by the early close", async () => {
    const [client, server] = duplexPair();
    let sent = 0;
    const chunk = Buffer.alloc(16 * 1024, 0x61);
    server.on("data", () => {
      // the request has arrived: stream on without ever ending (a peer that never ends), one chunk per turn of the loop as a real socket delivers them, until the client has dropped the connection
      const pump = (): void => {
        if (client.destroyed || server.destroyed || sent >= 64 * 1024 * 1024) return;
        sent += chunk.length;
        if (!server.write(chunk)) return void server.once("drain", pump);
        setImmediate(pump);
      };
      pump();
    });
    await expectCode(createChannelClient(async () => client, { timeoutMs: 20_000 }).tick("loop"), "bad_reply");
    expect(client.destroyed).toBe(true);
    expect(sent, "the guest was cut off near one frame, not allowed to stream on").toBeLessThan(4 + FRAME_MAX + 16 * chunk.length);
  });

  it("a reply whose length prefix is already past one frame is dropped at once, before the rest arrives", async () => {
    const [client, server] = duplexPair();
    server.on("data", () => {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(FRAME_MAX + 1, 0);
      server.write(head); // never ends, never sends the rest
    });
    await expectCode(createChannelClient(async () => client, { timeoutMs: 20_000 }).tick("loop"), "bad_reply");
    expect(client.destroyed).toBe(true);
  });

  it("the frame that held the credential is zeroed after the request, whether it answered or not", async () => {
    for (const answers of [true, false]) {
      const written: Buffer[] = [];
      const wire = new Duplex({
        read() {},
        write(chunk: Buffer, _enc, cb) {
          written.push(chunk); // the very buffer the client built (a Buffer is passed through by reference)
          const reply = Buffer.from(JSON.stringify({ ok: true }));
          const frame = Buffer.alloc(4 + reply.length);
          frame.writeUInt32BE(reply.length, 0);
          reply.copy(frame, 4);
          cb();
          if (answers) {
            this.push(frame);
            this.push(null);
          } else this.destroy();
        },
      });
      const result = createChannelClient(async () => wire).tokenPut(Buffer.from(TOKEN)).then(() => undefined, (e: unknown) => e);
      await result;
      expect(written).toHaveLength(1);
      expect(written[0]!.includes(Buffer.from(TOKEN)), "the credential is not left in the frame").toBe(false);
      expect(written[0]!.every((b) => b === 0)).toBe(true);
    }
  });

  it("a credential that cannot be a token is refused before anything is dialed", async () => {
    const far = fakeChannel(() => ({ ok: true }));
    const client = createChannelClient(far.connect);
    await expectCode(client.tokenPut(Buffer.alloc(0)), "bad_request");
    await expectCode(client.tokenPut(Buffer.alloc(TOKEN_MAX + 1, 0x61)), "bad_request");
    expect(far.connections()).toBe(0);
  });
});

const sockets = unixSocketsRefused();
describe.skipIf(sockets)("against the real session over a unix socket", () => {
  const sessions: GuestSession[] = [];
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.request({ op: "stop" }).catch(() => undefined); // fx-swallow-ok: a session that already ended has nothing more to stop
  });

  it("token_put, the first tick, events_read and a halt stop round-trip through the client's frames", async () => {
    const scratch = tempDir("fx-cc-");
    const bin = path.join(scratch, "bin");
    mkdirSync(bin);
    const standin = path.join(bin, "host-standin");
    writeFileSync(standin, `#!${process.execPath}\nprocess.stdin.on("data",()=>process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,usage:{input_tokens:1,output_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4},modelUsage:{"claude-haiku-4-5":{}}})+"\\n"));process.stdin.on("end",()=>process.exit(0));\n`);
    chmodSync(standin, 0o755);
    const priv = path.join(scratch, "path");
    mkdirSync(priv);
    const checkout = path.join(scratch, "checkout");
    mkdirSync(checkout);
    const dir = path.join(scratch, "state");
    const session = createGuestSession({ dir, runtime: guestRuntime({ claudePath: standin, env: { PATH: priv, HOME: scratch } }) });
    sessions.push(session);
    writeFileSync(path.join(dir, SESSION_CONFIG_FILE), JSON.stringify({ repo_gh_id: "424242", repo_checkout: checkout }), { mode: 0o600 });
    const socket = path.join(tempDir("fxs-", socketTmpRoot()), "channel.sock");
    const listening = await session.serve(socket);
    try {
      const client = createChannelClient(async () => net.createConnection(socket));
      await client.tokenPut(Buffer.from(TOKEN));
      expect(await client.tick("loop")).toEqual({ started: true });
      let events: string[] = [];
      for (let i = 0; i < 100 && !events.some((l) => l.includes('"usage_tick"')); i++) {
        await new Promise((r) => setTimeout(r, 50));
        events = (await client.eventsRead(0)).lines;
      }
      expect(events.some((l) => l.includes('"usage_tick"'))).toBe(true);
      expect(await client.stop("halted")).toEqual({ survivors: 0, tokenWiped: true, pid: process.pid }); // the real session's own program
      await expectCode(client.tick("loop"), "stopped");
    } finally {
      await listening.close();
    }
  });
});
