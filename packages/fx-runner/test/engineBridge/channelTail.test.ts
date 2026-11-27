import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChannelTail, type ChannelStream, type ChannelTail } from "../../src/engineBridge/channelTail.js";
import { engineLine, fakeGuest, hostEventLine, INSTANCE_E, INSTANCE_H, type FakeGuest } from "../helpers/fakeGuestStreams.js";

const uid = process.getuid?.();
let dir: string;
let logs: string[];
let guest: FakeGuest;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-ctail-"));
  logs = [];
  guest = fakeGuest();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cursorFile = (stream: ChannelStream): string => path.join(dir, `${stream}.cursor.json`);
const tailOf = (stream: ChannelStream, over: { foreign?: (id: string) => boolean } = {}): ChannelTail =>
  createChannelTail({ channel: guest.channel, stream, cursorPath: cursorFile(stream), uid, secrets: () => [], log: (l) => logs.push(l), ...(over.foreign === undefined ? {} : { isForeignInstance: over.foreign }) });
const saved = (stream: ChannelStream): Record<string, unknown> => JSON.parse(readFileSync(cursorFile(stream), "utf8")) as Record<string, unknown>;

describe("each stream is read through the channel, never from a file of this machine", () => {
  it("asks the host's stream with no stream key and the engine's own with `engine`, each from its own cursor", async () => {
    guest.append("events", hostEventLine(0) + hostEventLine(1));
    guest.append("engine", engineLine(0));
    const host = tailOf("events");
    const engine = tailOf("engine");
    const [h, e] = [await host.poll(), await engine.poll()];
    expect(h.events.map((x) => x.seq)).toEqual([0, 1]);
    expect(e.events.map((x) => x.seq)).toEqual([0]);
    expect(guest.far.requests.map((q) => q.header)).toEqual([
      { op: "events_read", after: 0 },
      { op: "events_read", after: 0, stream: "engine" },
    ]);
    host.ack(1);
    engine.ack(0);
    expect(saved("events")).toMatchObject({ engine_instance_id: INSTANCE_H, last_acked_seq: 1 });
    expect(saved("engine")).toMatchObject({ engine_instance_id: INSTANCE_E, last_acked_seq: 0 });
  });

  it("keeps an exact byte cursor: an ack of part of a batch moves it to the end of that event's line, and a rewind reads the rest again", async () => {
    guest.append("engine", engineLine(0) + engineLine(1) + engineLine(2));
    const tail = tailOf("engine");
    expect((await tail.poll()).events.map((x) => x.seq)).toEqual([0, 1, 2]);
    tail.ack(0);
    expect(saved("engine").offset).toBe(Buffer.byteLength(engineLine(0)));
    tail.rewind();
    const again = await tail.poll();
    expect(again.events.map((x) => x.seq)).toEqual([1, 2]);
    expect(guest.reads.at(-1)).toEqual({ after: Buffer.byteLength(engineLine(0)), stream: "engine" });
    tail.ack(2);
    expect((await tail.poll()).events).toEqual([]);
  });

  it("a poll with a batch outstanding is refused until it is acked or rewound", async () => {
    guest.append("engine", engineLine(0));
    const tail = tailOf("engine");
    await tail.poll();
    await expect(tail.poll()).rejects.toThrow(/not yet acked/);
    tail.rewind();
    expect((await tail.poll()).events).toHaveLength(1);
  });
});

describe("the cursor survives a restart", () => {
  it("a new tail on the same cursor asks from the saved offset and sends nothing twice or never", async () => {
    guest.append("engine", engineLine(0) + engineLine(1));
    const first = tailOf("engine");
    await first.poll();
    first.ack(1);
    const saveAt = saved("engine").offset as number;
    guest.append("engine", engineLine(2));
    const second = tailOf("engine");
    const got = await second.poll();
    expect(got.events.map((x) => x.seq)).toEqual([2]);
    expect(guest.reads.at(-1)).toEqual({ after: saveAt, stream: "engine" });
  });

  it("a guest file that restarted shorter is read again from 0, and what the cloud already holds is skipped", async () => {
    guest.append("engine", engineLine(0) + engineLine(1) + engineLine(2));
    const first = tailOf("engine");
    await first.poll();
    first.ack(2);
    // a rotation: the same instance, a shorter file that still holds old lines and one new
    guest.streams.engine = Buffer.from(engineLine(2) + engineLine(3));
    const next = await tailOf("engine").poll();
    expect(next.status).toBe("ok");
    expect(next.events.map((x) => x.seq)).toEqual([3]);
  });

  it("a new session on a fresh disk is a reset of the instance, not a gap", async () => {
    guest.append("engine", engineLine(0) + engineLine(1));
    const tail = tailOf("engine");
    await tail.poll();
    tail.ack(1);
    guest.streams.engine = Buffer.from(engineLine(0, "1b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a99"));
    const next = await tail.poll();
    expect(next.reset).toBe(true);
    expect(next.gaps).toEqual([]);
    expect(next.events.map((x) => x.seq)).toEqual([0]);
  });
});

describe("a channel that cannot be read, and lines that cannot be trusted", () => {
  it("an unreadable channel is an idle poll and one fixed line; the next poll asks again from the same place", async () => {
    guest.append("events", hostEventLine(0));
    const tail = tailOf("events");
    guest.down = true;
    for (let i = 0; i < 3; i++) expect((await tail.poll()).status).toBe("idle");
    expect(logs).toEqual(["engine-bridge: an engine session's channel could not be read; trying again later"]);
    guest.down = false;
    expect((await tail.poll()).events.map((x) => x.seq)).toEqual([0]);
    expect(existsSync(cursorFile("events"))).toBe(false); // nothing was acked, so nothing was saved
  });

  it("an event of the other stream's engine instance is dropped, as the file tails drop it", async () => {
    guest.append("engine", engineLine(0) + engineLine(1, INSTANCE_H));
    const tail = tailOf("engine", { foreign: (id) => id === INSTANCE_H });
    const got = await tail.poll();
    expect(got.events.map((x) => x.seq)).toEqual([0]);
    expect(got.dropped.schema).toBe(1);
  });

  it("a line of invalid UTF-8 is dropped without moving the cursor off its true byte offset", async () => {
    guest.append("engine", Buffer.concat([Buffer.from([0xff, 0xfe, 0x7b, 0x0a]), Buffer.from(engineLine(0))]));
    const tail = tailOf("engine");
    const got = await tail.poll();
    expect(got.events.map((x) => x.seq)).toEqual([0]);
    expect(got.dropped.schema).toBe(1);
    tail.ack(0);
    expect(saved("engine").offset).toBe(4 + Buffer.byteLength(engineLine(0)));
  });

  it("redacts a secret in a line before it is judged, like the file tail", async () => {
    guest.append("engine", engineLine(0, INSTANCE_E, { origin: "cron-SECRET-1234" }));
    const tail = createChannelTail({ channel: guest.channel, stream: "engine", cursorPath: cursorFile("engine"), uid, secrets: () => ["SECRET-1234"], log: (l) => logs.push(l) });
    const got = await tail.poll();
    expect(got.events).toEqual([]);
  });
});

describe("a reply with offsets the guest made up builds nothing from them", () => {
  const hostile = (read: (after: number) => unknown): ChannelTail =>
    createChannelTail({ channel: { eventsRead: async (after) => read(after) as never }, stream: "engine", cursorPath: cursorFile("engine"), uid, secrets: () => [], log: (l) => logs.push(l) });

  it("a span far past one read window is an idle poll and one fixed line, before any byte is made (no allocation, no cursor kept)", async () => {
    let made = 0;
    const alloc = Buffer.alloc;
    Buffer.alloc = ((...a: Parameters<typeof alloc>) => {
      made = Math.max(made, Number(a[0]));
      return alloc(...a);
    }) as typeof Buffer.alloc;
    const before = process.memoryUsage().rss;
    try {
      const tail = hostile((after) => ({ lines: ["x"], ends: [after + 400_000_000], next: after + 400_000_000, reset: false }));
      const result = await tail.poll();
      expect(result.status).toBe("idle");
      expect(result.events).toEqual([]);
    } finally {
      Buffer.alloc = alloc;
    }
    expect(made).toBeLessThan(1_000_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(150 * 1024 * 1024);
    expect(logs).toEqual(["engine-bridge: an engine session's channel could not be read; trying again later"]);
    expect(existsSync(cursorFile("engine"))).toBe(false);
  });

  it("a first end at or before where the read began, a falling end and a span of nothing are each idle", async () => {
    for (const ends of [[0], [-3], [5, 2], [1, 1]]) {
      const tail = hostile(() => ({ lines: ends.map(() => "x"), ends, next: ends[ends.length - 1], reset: false }));
      expect((await tail.poll()).status).toBe("idle");
    }
  });
});
