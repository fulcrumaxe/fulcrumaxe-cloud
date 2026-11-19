import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { FILE_PIECE, MAX_FILE_BYTES, checkGuestPath, guestFileMode } from "../../../src/vm/sandboxd/files.js";
import { AgentError, MAX_OUTPUT, createGuestAgent, viaFirecrackerVsock } from "../../../src/vm/sandboxd/guestAgent.js";
import { makeRig, onCleanup, runCleanups, scratch, startSilentProxy, trackTimers, type Rig } from "./helpers.js";

afterEach(runCleanups);
const params = (name: string) => ({ name, template: "fx-agent", vcpus: 2, memMb: 512 });
const MiB = 1 << 20;

/** `n` bytes of a repeating, position-dependent pattern, produced a piece at a time so the test never holds them all. */
async function* pattern(n: number, piece = MiB): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < n; at += piece) {
    const len = Math.min(piece, n - at);
    const b = Buffer.alloc(len);
    for (let i = 0; i < len; i++) b[i] = (at + i) * 31 + ((at + i) >>> 8) & 0xff;
    yield b;
  }
}
const sha = async (src: AsyncIterable<Uint8Array>): Promise<string> => {
  const h = createHash("sha256");
  for await (const c of src) h.update(c);
  return h.digest("hex");
};

async function boot(over: Parameters<typeof makeRig>[0] = {}): Promise<{ rig: Rig; agent: ReturnType<typeof makeRig>["agents"] extends Map<string, infer A> ? A : never; sb: Awaited<ReturnType<Rig["daemon"]["create"]>> }> {
  const rig = makeRig(over);
  const sb = await rig.daemon.create(params("alpha"));
  return { rig, agent: rig.agents.get("alpha") as never, sb };
}

describe("files round trip byte for byte", () => {
  for (const [label, size] of [["1 B", 1], ["1 MiB", MiB], ["64 MiB", 64 * MiB]] as const) {
    it(`${label}: written in pieces, read back in pieces, identical, and no piece larger than the bound`, async () => {
      const { sb, agent } = await boot();
      await sb.writeFiles([{ path: "/work/data.bin", size, content: { chunks: pattern(size) } }]);
      const stored = agent.files.get("/work/data.bin");
      expect(stored?.data.length).toBe(size);
      const h = createHash("sha256");
      let biggest = 0;
      let pieces = 0;
      const got = await sb.readFile("/work/data.bin", (chunk) => {
        h.update(chunk);
        biggest = Math.max(biggest, chunk.length);
        pieces++;
      });
      expect(got).toBe(size);
      expect(h.digest("hex")).toBe(await sha(pattern(size)));
      expect(biggest).toBeLessThanOrEqual(FILE_PIECE);
      expect(pieces).toBeGreaterThanOrEqual(Math.ceil(size / FILE_PIECE));
    }, 120_000);
  }

  it("a Buffer body works the same, and a zero-byte file round-trips", async () => {
    const { sb } = await boot();
    await sb.writeFiles([{ path: "/a", content: Buffer.from("hello") }, { path: "/empty", content: Buffer.alloc(0) }]);
    const read = async (p: string): Promise<string> => {
      const parts: Buffer[] = [];
      await sb.readFile(p, (c) => void parts.push(c));
      return Buffer.concat(parts).toString();
    };
    expect(await read("/a")).toBe("hello");
    expect(await read("/empty")).toBe("");
  });

  it("writes leave the socket's write size at the piece bound even for a source that hands over one 5 MiB block", async () => {
    const rig = makeRig();
    await rig.daemon.create(params("alpha"));
    const writes: number[] = [];
    // wrap the vsock connection so each write the client makes is seen
    const connect = viaFirecrackerVsock(`${rig.helper.entries.get("alpha")!.dir}/v.sock`);
    const agent = createGuestAgent(async (): Promise<Duplex> => {
      const sock = await connect();
      const write = sock.write.bind(sock) as (...a: unknown[]) => boolean;
      sock.write = ((data: Buffer, ...rest: unknown[]) => (writes.push(data.length), write(data, ...rest))) as typeof sock.write;
      return sock;
    }, 30_000);
    await agent.put({ path: "/big", size: 5 * MiB, content: Buffer.alloc(5 * MiB, 7) });
    expect(Math.max(...writes)).toBeLessThanOrEqual(FILE_PIECE);
    expect(writes.filter((n) => n === FILE_PIECE).length).toBe(5);
  });

  it("a reader that is slow stops the guest instead of buffering the file: bytes stay queued on the sending side", async () => {
    const { sb, agent } = await boot();
    await sb.writeFiles([{ path: "/big", size: 32 * MiB, content: { chunks: pattern(32 * MiB) } }]);
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    let first = true;
    let biggest = 0;
    const read = sb.readFile("/big", async (chunk) => {
      biggest = Math.max(biggest, chunk.length);
      if (!first) return;
      first = false;
      await blocked;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(agent.lastSock?.writableLength ?? 0).toBeGreaterThan(8 * MiB);
    release();
    expect(await read).toBe(32 * MiB);
    expect(biggest).toBeLessThanOrEqual(FILE_PIECE); // what piled up while the sink was slow is still handed over in bounded pieces
  }, 60_000);

  it("a transfer that keeps making progress outlives the idle bound, and ends at the overall bound", async () => {
    const { rig, sb } = await boot();
    await sb.writeFiles([{ path: "/slow", size: 8 * MiB, content: { chunks: pattern(8 * MiB) } }]);
    const connect = viaFirecrackerVsock(`${rig.helper.entries.get("alpha")!.dir}/v.sock`);
    const slowSink = async (): Promise<void> => void (await new Promise((r) => setTimeout(r, 120)));
    // 8 pieces x 120 ms is about 1 s: far past the 300 ms idle bound, but no 300 ms passes without a piece
    const steady = createGuestAgent(connect, 300);
    expect(await steady.get("/slow", slowSink)).toBe(8 * MiB);
    // the same transfer with an overall bound of 400 ms is cut off however steady it is
    const capped = createGuestAgent(connect, 300, 400);
    await expect(capped.get("/slow", slowSink)).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("paths and modes are refused on the host, before anything is sent", () => {
  const bad = ["relative/x", "", "/a\0b", "/a/../b", "/../x", "/a/..", "/a/./b", "/a//b", `/${"x".repeat(5000)}`];
  it("writeFiles and readFile refuse each with 400 bad_request and the guest sees no request", async () => {
    const { sb, agent } = await boot();
    const before = agent.ops.length;
    for (const p of bad) {
      await expect(sb.writeFiles([{ path: p, content: Buffer.from("x") }])).rejects.toMatchObject({ status: 400, code: "bad_request" });
      await expect(sb.readFile(p, () => undefined)).rejects.toMatchObject({ status: 400, code: "bad_request" });
    }
    expect(agent.ops.length).toBe(before);
    expect(agent.files.size).toBe(0);
  });

  it("one bad file in a list writes none of the list", async () => {
    const { sb, agent } = await boot();
    await expect(sb.writeFiles([{ path: "/good", content: Buffer.from("x") }, { path: "/a/../bad", content: Buffer.from("x") }])).rejects.toMatchObject({ code: "bad_request" });
    await expect(sb.writeFiles([{ path: "/good", content: Buffer.from("x") }, { path: "/stream", content: { chunks: [Buffer.from("x")] } }])).rejects.toMatchObject({ code: "bad_request" });
    expect(agent.files.size).toBe(0);
  });

  it("the unit rules: normalised absolute paths pass; every refusal clause is its own test", () => {
    expect(checkGuestPath("/work/a.txt")).toBe("/work/a.txt");
    expect(() => checkGuestPath("work")).toThrow();
    expect(() => checkGuestPath("/a\0")).toThrow();
    expect(() => checkGuestPath("/a/../b")).toThrow();
    expect(() => checkGuestPath("/a/b/..")).toThrow();
    expect(() => checkGuestPath("/a//b")).toThrow();
    expect(() => checkGuestPath(undefined as unknown as string)).toThrow();
  });

  it("modes follow agent.py: 0o644 by default, masked to 0o777, a non-integer refused", async () => {
    expect(guestFileMode(undefined)).toBe(0o644);
    expect(guestFileMode(0o4755)).toBe(0o755);
    for (const m of [1.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) expect(() => guestFileMode(m)).toThrow();
    const { sb, agent } = await boot();
    await sb.writeFiles([{ path: "/m1", content: Buffer.from("x") }, { path: "/m2", mode: 0o600, content: Buffer.from("x") }, { path: "/m3", mode: 0o4755, content: Buffer.from("x") }]);
    expect([...agent.files].map(([p, f]) => [p, f.mode])).toEqual([["/m1", 0o644], ["/m2", 0o600], ["/m3", 0o755]]);
    await expect(sb.writeFiles([{ path: "/m4", mode: 1.5, content: Buffer.from("x") }])).rejects.toMatchObject({ code: "bad_request" });
    expect(agent.files.has("/m4")).toBe(false);
  });

  it("a stopped sandbox answers 409 not_running", async () => {
    const { sb } = await boot();
    await sb.stop();
    await expect(sb.writeFiles([{ path: "/a", content: Buffer.from("x") }])).rejects.toMatchObject({ status: 409, code: "not_running" });
    await expect(sb.readFile("/a", () => undefined)).rejects.toMatchObject({ status: 409, code: "not_running" });
  });
});

describe("a transfer that goes wrong ends, and leaves nothing half-sent", () => {
  const code = async (p: Promise<unknown>): Promise<string> => ((await p.then(() => undefined, (e: unknown) => e)) as AgentError).code;

  it("a source shorter or longer than its size is refused (the guest would wait for the missing bytes), and nothing is stored", async () => {
    const { sb, agent } = await boot();
    expect(await code(sb.writeFiles([{ path: "/short", size: 10, content: { chunks: [Buffer.alloc(9)] } }]))).toBe("bad_request");
    expect(await code(sb.writeFiles([{ path: "/long", size: 10, content: { chunks: [Buffer.alloc(11)] } }]))).toBe("bad_request");
    expect(agent.files.size).toBe(0);
  });

  it("a source that never ends is cut off as soon as it passes its size, not read to the end", async () => {
    const { sb, agent } = await boot();
    let pulled = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        pulled++;
        yield Buffer.alloc(MiB);
      }
    }
    expect(await code(sb.writeFiles([{ path: "/endless", size: 10, content: { chunks: endless() } }]))).toBe("bad_request");
    expect(pulled).toBeLessThanOrEqual(2);
    expect(agent.files.size).toBe(0);
  });

  it("a size past the agent's 256 MiB limit is refused without a connection", async () => {
    let connects = 0;
    const agent = createGuestAgent(() => (connects++, Promise.reject(new Error("no connection expected"))), 200);
    expect(await code(agent.put({ path: "/huge", size: MAX_FILE_BYTES + 1, content: { chunks: [] } }))).toBe("bad_request");
    expect(connects).toBe(0);
  });

  it("reading a missing file is `refused`; a reply that lies about its size, or ends early, is `bad_reply`", async () => {
    const { sb, agent } = await boot();
    expect(await code(sb.readFile("/nope", () => undefined))).toBe("refused");
    // 40 of the 100 promised bytes, then the guest closes the connection
    agent.getReply = () => (setTimeout(() => agent.lastSock?.end(), 50), { header: { ok: true, size: 100 }, blobs: [Buffer.alloc(40)] });
    expect(await code(sb.readFile("/short", () => undefined))).toBe("bad_reply");
    agent.getReply = () => ({ header: { ok: true, size: MAX_FILE_BYTES + 1 }, blobs: [] });
    expect(await code(sb.readFile("/huge", () => undefined))).toBe("bad_reply");
    agent.getReply = () => ({ header: { ok: true, size: "5" }, blobs: [] });
    expect(await code(sb.readFile("/str", () => undefined))).toBe("bad_reply");
  });

  it("a sink that throws ends the read with its error and closes the connection", async () => {
    const { sb, agent } = await boot();
    await sb.writeFiles([{ path: "/f", content: Buffer.alloc(3 * MiB) }]);
    await expect(sb.readFile("/f", () => Promise.reject(new Error("disk full")))).rejects.toThrow("disk full");
    await new Promise((r) => setTimeout(r, 100));
    expect(agent.lastSock?.destroyed).toBe(true);
  });
});

describe("transfers are bounded in time", () => {
  const timed = async (p: Promise<unknown>): Promise<{ err: unknown; ms: number }> => {
    const t = Date.now();
    const err = await p.then(() => undefined, (e: unknown) => e);
    return { err, ms: Date.now() - t };
  };

  it("put and get against a proxy that never answers CONNECT time out", async () => {
    const agent = createGuestAgent(viaFirecrackerVsock(startSilentProxy(), 5252, 60_000), 150);
    for (const run of [() => agent.put({ path: "/a", size: 1, content: Buffer.from("x") }), () => agent.get("/a", () => undefined)]) {
      const { err, ms } = await timed(run());
      expect((err as AgentError).code).toBe("timeout");
      expect(ms).toBeLessThan(2000);
    }
  });

  it("a guest that takes the file and never answers, or sends half and stops, ends on the idle bound", async () => {
    const { rig, sb, agent } = await boot();
    const live = createGuestAgent(viaFirecrackerVsock(`${rig.helper.entries.get("alpha")!.dir}/v.sock`), 250);
    agent.getReply = () => ({ header: { ok: true, size: 10 * MiB }, blobs: [Buffer.alloc(MiB)] }); // 1 MiB of 10 MiB, then silence
    const half = await timed(live.get("/half", () => undefined));
    expect((half.err as AgentError).code).toBe("timeout");
    expect(half.ms).toBeLessThan(3000);
    agent.gate = new Promise(() => undefined);
    const mute = await timed(live.put({ path: "/mute", size: 3, content: Buffer.from("abc") }));
    expect((mute.err as AgentError).code).toBe("timeout");
    expect(mute.ms).toBeLessThan(3000);
    void sb;
  });
});

describe("exec replies larger than the reader's pause bound", () => {
  it("returns an 8 MiB stdout and a 5 MiB stderr (the socket is not paused while a reply body is awaited)", async () => {
    const { rig } = await boot();
    const agent = createGuestAgent(viaFirecrackerVsock(`${rig.helper.entries.get("alpha")!.dir}/v.sock`), 5000);
    const result = await agent.runInGuest({ argv: ["sh", "-c", `head -c ${8 * MiB} /dev/zero; head -c ${5 * MiB} /dev/zero 1>&2`], timeoutS: 30 });
    expect(result.exit).toBe(0);
    expect(result.stdout.length).toBe(8 * MiB);
    expect(result.stderr.length).toBe(5 * MiB);
  }, 30_000);
});

describe("a guest cannot make the host buffer more than the agent's own output cap", () => {
  /** A guest that answers the handshake and then any request with a frame naming `stdout` bytes, of which it sends `send`. */
  function lyingGuest(stdout: number, send: number): string {
    const file = path.join(scratch(), "lie.sock");
    const server = net.createServer((s) => {
      s.on("error", () => undefined);
      s.once("data", () => {
        s.write("OK 1\n");
        s.once("data", () => {
          const head = Buffer.from(JSON.stringify({ ok: true, exit: 0, stdout_size: stdout, stderr_size: 0 }));
          const len = Buffer.alloc(4);
          len.writeUInt32BE(head.length);
          s.write(Buffer.concat([len, head, Buffer.alloc(send)]));
        });
      });
    }).listen(file);
    onCleanup(() => server.close());
    return file;
  }
  const agentFor = (file: string) => createGuestAgent(viaFirecrackerVsock(file), 3000);

  it("a stream of exactly 16 MiB is accepted", async () => {
    const r = await agentFor(lyingGuest(MAX_OUTPUT, MAX_OUTPUT)).runInGuest({ argv: ["x"], timeoutS: 5 });
    expect(r.stdout.length).toBe(MAX_OUTPUT);
  }, 20_000);

  it("a stream of 16 MiB + 1 is refused as bad_reply before the body is read (the guest sends only a few bytes, and the answer is not a timeout)", async () => {
    const t = Date.now();
    await expect(agentFor(lyingGuest(MAX_OUTPUT + 1, 10)).runInGuest({ argv: ["x"], timeoutS: 5 })).rejects.toMatchObject({ code: "bad_reply" });
    expect(Date.now() - t).toBeLessThan(2500);
  });

  it("a stream of 64 MiB is refused the same way", async () => {
    await expect(agentFor(lyingGuest(64 << 20, 10)).runInGuest({ argv: ["x"], timeoutS: 5 })).rejects.toMatchObject({ code: "bad_reply" });
  });
});

describe("writeFiles validates every size before the first byte is written", () => {
  it.each([
    ["past the 256 MiB limit", 300 * MiB],
    ["one past the limit", MAX_FILE_BYTES + 1],
    ["NaN", Number.NaN],
    ["negative", -1],
    ["a fraction", 1.5],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["unsafe", Number.MAX_SAFE_INTEGER + 2],
  ])("a later entry with a size %s writes nothing, not even the earlier file", async (_label, size) => {
    const { sb, agent } = await boot();
    const before = agent.ops.length;
    await expect(sb.writeFiles([{ path: "/a", content: Buffer.from("first") }, { path: "/b", size, content: { chunks: [] } }])).rejects.toMatchObject({ status: 400, code: "bad_request" });
    expect(agent.ops.length).toBe(before); // no request of any kind reached the guest
    expect(agent.files.size).toBe(0);
  });

  it("zero passes the plan (the lower bound is inclusive)", async () => {
    const { sb, agent } = await boot();
    await sb.writeFiles([{ path: "/empty", size: 0, content: { chunks: [] } }]);
    expect(agent.files.get("/empty")?.data.length).toBe(0);
  });
});

describe("the transfer's overall cap timer is cleared", () => {
  it("when the transfer ends, on success and on failure", async () => {
    const { rig, sb } = await boot();
    await sb.writeFiles([{ path: "/t", content: Buffer.from("timer") }]);
    const agent = createGuestAgent(viaFirecrackerVsock(`${rig.helper.entries.get("alpha")!.dir}/v.sock`), 5000, 777_001);
    const ok = await trackTimers([777_001], async () => void (await agent.get("/t", () => undefined)));
    expect(ok.made).toBe(1);
    expect(ok.uncleared).toBe(0);
    const failed = await trackTimers([777_001], async () => void (await agent.get("/missing", () => undefined).catch(() => undefined)));
    expect(failed.made).toBe(1);
    expect(failed.uncleared).toBe(0);
  });
});
