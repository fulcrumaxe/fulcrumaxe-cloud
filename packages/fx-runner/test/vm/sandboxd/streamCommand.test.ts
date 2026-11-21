import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unixSocketsRefused } from "../../helpers/needsHostSockets.js";
import { socketTmpRoot } from "../../helpers/tmpRoot.js";
import { AgentError, createGuestAgent, type GuestAgent } from "../../../src/vm/sandboxd/guestAgent.js";
import type { GuestStream, StreamFrame } from "../../../src/vm/sandboxd/streamCommand.js";

/**
 * D#587 B-5a-RT-1: the production client of the guest agent's `exec_stream` and `kill`, against a guest that sends exactly the frames a case needs
 * (so every way the framing can be broken is reached). The real `agent.py` is run in streamCommandReal.test.ts. "Fake guest" below always means this one.
 */
const skip = unixSocketsRefused();
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const frame = (obj: object, body: Buffer = Buffer.alloc(0)): Buffer => {
  const json = Buffer.from(JSON.stringify(obj));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return Buffer.concat([len, json, body]);
};
const data = (seq: number, bytes: string | Buffer, stream: "stdout" | "stderr" = "stdout"): Buffer => {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return frame({ ev: "data", stream, seq, size: b.length }, b);
};
const exit = (seq: number, over: object = {}): Buffer => frame({ ev: "exit", seq, exit: 0, signal: null, timed_out: false, ...over });

interface FakeGuest {
  agent: GuestAgent;
  /** Every request the guest read, in order. */
  requests: Array<Record<string, unknown>>;
  connects: () => number;
  setStream(fn: (sock: net.Socket, header: Record<string, unknown>) => void): void;
  setKill(fn: (header: Record<string, unknown>) => object): void;
}

function fakeGuest(opts: { caps?: string[]; ioTimeoutMs?: number } = {}): FakeGuest {
  const dir = mkdtempSync(path.join(socketTmpRoot(), "fx-strm-"));
  dirs.push(dir);
  const file = path.join(dir, "g.sock");
  const requests: Array<Record<string, unknown>> = [];
  let streamFn: (sock: net.Socket, header: Record<string, unknown>) => void = (sock) => void sock.end();
  let killFn: (header: Record<string, unknown>) => object = () => ({ ok: true, signalled: true });
  let connects = 0;
  const server = net.createServer((sock) => {
    sock.on("error", () => undefined);
    let have = Buffer.alloc(0);
    let header: Record<string, unknown> | undefined;
    sock.on("data", (c: Buffer) => {
      have = Buffer.concat([have, c]);
      if (header === undefined) {
        if (have.length < 4 || have.length < 4 + have.readUInt32BE(0)) return;
        header = JSON.parse(have.subarray(4, 4 + have.readUInt32BE(0)).toString()) as Record<string, unknown>;
        have = have.subarray(4 + have.readUInt32BE(0));
      }
      if (have.length < Number(header["stdin_size"] ?? 0) || header["done"] === true) return;
      header["done"] = true;
      const h = header;
      requests.push({ ...h, stdin: have.toString() });
      if (h["op"] === "ping") sock.write(frame({ ok: true, proto: 1, ...(opts.caps === undefined ? { caps: ["exec_stream", "kill", "token"] } : opts.caps.length === 0 ? {} : { caps: opts.caps }) }));
      else if (h["op"] === "kill") sock.write(frame(killFn(h)));
      else if (h["op"] === "exec_stream") streamFn(sock, h);
    });
  });
  server.listen(file);
  cleanups.push(() => server.close());
  const agent = createGuestAgent(
    () =>
      new Promise((resolve, reject) => {
        connects++;
        const s = net.createConnection(file);
        s.once("error", reject);
        s.once("connect", () => resolve(s));
      }),
    opts.ioTimeoutMs ?? 2000,
  );
  return { agent, requests, connects: () => connects, setStream: (fn) => void (streamFn = fn), setKill: (fn) => void (killFn = fn) };
}

const REQ = { id: "run-1", argv: ["/bin/echo", "hi"] };
const code = async (p: Promise<unknown>): Promise<string> => ((await p.then(() => undefined, (e: unknown) => e)) as AgentError).code;
async function drain(stream: GuestStream): Promise<StreamFrame[]> {
  const out: StreamFrame[] = [];
  for await (const f of stream.frames) out.push(f);
  return out;
}

describe.skipIf(skip)("streamInGuest: the request and the frames of a clean run", () => {
  it("sends the exec fields with a stdin size and the id, then yields the frames in order and settles `done` with the exit frame", async () => {
    const g = fakeGuest();
    g.setStream((sock) => sock.write(Buffer.concat([data(0, "out1"), data(1, "err1", "stderr"), data(2, "out2"), exit(3, { exit: 4 })])));
    const stream = await g.agent.streamInGuest({ ...REQ, stdin: Buffer.from("prompt"), cwd: "/work", env: { A: "b" }, user: "ubuntu", timeoutS: 30 });
    const got = await drain(stream);
    expect(got.map((f) => [f.stream, f.data.toString()])).toEqual([["stdout", "out1"], ["stderr", "err1"], ["stdout", "out2"]]);
    expect(await stream.done).toEqual({ exit: 4, signal: null, timedOut: false });
    const sent = g.requests.find((r) => r["op"] === "exec_stream");
    expect(sent).toMatchObject({ op: "exec_stream", id: "run-1", argv: ["/bin/echo", "hi"], cwd: "/work", env: { A: "b" }, user: "ubuntu", timeout_s: 30, stdin_size: 6, stdin: "prompt" });
    expect(sent).not.toHaveProperty("token");
  });

  it("a signal and a timeout come through as they are on the exit frame (no exit code is made up)", async () => {
    const g = fakeGuest();
    g.setStream((sock) => sock.write(exit(0, { exit: null, signal: 9 })));
    const killed = await g.agent.streamInGuest(REQ);
    await drain(killed);
    expect(await killed.done).toEqual({ exit: null, signal: 9, timedOut: false });
    g.setStream((sock) => sock.write(Buffer.concat([data(0, "x"), exit(1, { exit: null, signal: 9, timed_out: true })])));
    const timed = await g.agent.streamInGuest({ ...REQ, id: "run-2" });
    await drain(timed);
    expect(await timed.done).toEqual({ exit: null, signal: 9, timedOut: true });
  });

  it("a failed start (the agent's exit 127 with its own `error` text) is an ordinary exit frame, and the text goes nowhere", async () => {
    const g = fakeGuest();
    g.setStream((sock) => sock.write(exit(0, { exit: 127, error: "/secret/host/path: No such file" })));
    const stream = await g.agent.streamInGuest(REQ);
    await drain(stream);
    const done = await stream.done;
    expect(done).toEqual({ exit: 127, signal: null, timedOut: false });
    expect(JSON.stringify(done)).not.toContain("secret");
  });

  it("the guest's refusal before any frame (a duplicate id) is `refused`, with none of its words", async () => {
    const g = fakeGuest();
    g.setStream((sock) => sock.write(frame({ ok: false, code: "duplicate_id", error: "id in use /secret" })));
    const stream = await g.agent.streamInGuest(REQ);
    const err = (await drain(stream).then(() => undefined, (e: unknown) => e)) as AgentError;
    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe("refused");
    expect(err.message).not.toContain("secret");
    expect(await code(stream.done)).toBe("refused");
  });

  it("a token launch is sent with `token: true`", async () => {
    const g = fakeGuest();
    g.setStream((sock) => sock.write(exit(0)));
    const stream = await g.agent.streamInGuest({ ...REQ, token: true, user: "ubuntu" });
    await drain(stream);
    expect(g.requests.find((r) => r["op"] === "exec_stream")).toMatchObject({ token: true, user: "ubuntu" });
  });
});

describe.skipIf(skip)("streamInGuest: strict framing (one case per way the guest can break it; each ends `lost`, never a clean end)", () => {
  const big = (n: number): Buffer => Buffer.alloc(n, 0x61);
  const cases: Array<[string, (sock: net.Socket) => void]> = [
    ["a frame that is neither data nor exit", (s) => s.write(frame({ ev: "hello", seq: 0 }))],
    ["a frame with no `ev` and a seq", (s) => s.write(frame({ seq: 0 }))],
    ["a first seq that is not 0", (s) => s.write(data(1, "x"))],
    ["a repeated seq", (s) => s.write(Buffer.concat([data(0, "x"), data(0, "y")]))],
    ["a skipped seq", (s) => s.write(Buffer.concat([data(0, "x"), data(2, "y")]))],
    ["a seq that is a string", (s) => s.write(frame({ ev: "data", stream: "stdout", seq: "0", size: 1 }, Buffer.from("x")))],
    ["a fractional seq", (s) => s.write(frame({ ev: "data", stream: "stdout", seq: 0.5, size: 1 }, Buffer.from("x")))],
    ["a data frame of size 0", (s) => s.write(frame({ ev: "data", stream: "stdout", seq: 0, size: 0 }))],
    ["a data frame of size above 64 KiB", (s) => s.write(frame({ ev: "data", stream: "stdout", seq: 0, size: 65537 }, big(65537)))],
    ["a data frame with a negative size", (s) => s.write(frame({ ev: "data", stream: "stdout", seq: 0, size: -1 }))],
    ["a data frame on a stream that is neither", (s) => s.write(frame({ ev: "data", stream: "stdin", seq: 0, size: 1 }, Buffer.from("x")))],
    ["a body shorter than its size, then a close", (s) => s.end(frame({ ev: "data", stream: "stdout", seq: 0, size: 10 }, Buffer.from("abc")))],
    ["a header cut short by a close", (s) => s.end(frame({ ev: "data", stream: "stdout", seq: 0, size: 1 }).subarray(0, 9))],
    ["a second exit right behind the first", (s) => s.write(Buffer.concat([exit(0), exit(1)]))],
    ["bytes after the exit frame", (s) => s.write(Buffer.concat([exit(0), Buffer.from("trailing")]))],
    ["a data frame after the exit frame", (s) => s.write(Buffer.concat([exit(0), data(1, "late")]))],
    ["a close with no exit frame, after data", (s) => s.end(data(0, "partial"))],
    ["a close with no frame at all", (s) => s.end()],
    ["a header that is not JSON", (s) => s.write(Buffer.concat([Buffer.from([0, 0, 0, 5]), Buffer.from("{nope")]))],
    ["a header that is a JSON array", (s) => s.write(frame([1, 2]))],
    ["a header longer than the bound", (s) => s.write(Buffer.concat([Buffer.from([0, 0, 0x20, 0]), big(8192)]))],
    ["an empty header", (s) => s.write(Buffer.from([0, 0, 0, 0]))],
    // valid JSON, so only the length bound can refuse it: without the bound a header of any announced size would be read into memory
    ["a valid JSON header just over the bound", (s) => s.write(frame({ ev: "data", stream: "stdout", seq: 0, size: 1, pad: "p".repeat(4100) }, Buffer.from("x")))],
    ["a data frame with a fractional size", (s) => s.write(frame({ ev: "data", stream: "stdout", seq: 0, size: 1.5 }, Buffer.from("xx")))],
    ["a data frame with a size that is a string", (s) => s.write(frame({ ev: "data", stream: "stdout", seq: 0, size: "1" }, Buffer.from("x")))],
    ["an exit with an exit code that is a string", (s) => s.write(exit(0, { exit: "0" }))],
    ["an exit with no signal field", (s) => s.write(frame({ ev: "exit", seq: 0, exit: 0, timed_out: false }))],
    ["an exit with a fractional exit code", (s) => s.write(exit(0, { exit: 1.5 }))],
    ["an exit with a fractional signal", (s) => s.write(exit(0, { exit: null, signal: 9.5 }))],
    ["an exit with timed_out that is not a boolean", (s) => s.write(exit(0, { timed_out: 1 }))],
  ];
  it.each(cases)("%s", async (_name, send) => {
    const g = fakeGuest();
    g.setStream((sock) => send(sock));
    const stream = await g.agent.streamInGuest(REQ);
    const delivered: StreamFrame[] = [];
    const err = await (async () => {
      for await (const f of stream.frames) delivered.push(f);
    })().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe("lost");
    expect((err as AgentError).message).toBe("the guest agent failed: lost");
    if (_name.startsWith("a body shorter")) expect(delivered, "a truncated frame is never handed to the consumer").toEqual([]);
    expect(await code(stream.done)).toBe("lost");
  });

  it("a stream that fails stays failed: reading again throws the same code, and `done` is never resolved afterwards", async () => {
    const g = fakeGuest();
    g.setStream((sock) => sock.end(data(0, "x")));
    const stream = await g.agent.streamInGuest(REQ);
    await drain(stream).catch(() => undefined);
    await expect(drain(stream)).rejects.toMatchObject({ code: "lost" });
    await expect(stream.done).rejects.toMatchObject({ code: "lost" });
  });

  it("a frame of exactly 64 KiB is accepted", async () => {
    const g = fakeGuest();
    g.setStream((sock) => sock.write(Buffer.concat([data(0, big(65536)), exit(1)])));
    const stream = await g.agent.streamInGuest(REQ);
    expect((await drain(stream)).map((f) => f.data.length)).toEqual([65536]);
    await stream.done;
  });
});

describe.skipIf(skip)("streamInGuest: the guest must advertise the op, and what is refused before any connection", () => {
  it.each([["lists no exec_stream", ["kill"]], ["advertises nothing (an older guest)", []]])("a guest that %s: `unsupported`, and no stream request is ever written", async (_n, caps) => {
    const g = fakeGuest({ caps });
    await expect(g.agent.streamInGuest(REQ)).rejects.toMatchObject({ code: "unsupported" });
    expect(g.requests.map((r) => r["op"])).toEqual(["ping"]);
  });

  it("the guest's `caps` is read once while it is good, and asked again when it was not", async () => {
    const g = fakeGuest();
    g.setStream((sock) => sock.write(exit(0)));
    await drain(await g.agent.streamInGuest(REQ));
    await drain(await g.agent.streamInGuest({ ...REQ, id: "run-2" }));
    expect(g.requests.filter((r) => r["op"] === "ping")).toHaveLength(1);
  });

  it("a caps list that is not a list of short strings counts as none", async () => {
    // a guest that answers ping with something else entirely
    const dir = mkdtempSync(path.join(socketTmpRoot(), "fx-strm-"));
    dirs.push(dir);
    const server = net.createServer((s) => {
      s.on("error", () => undefined);
      s.on("data", () => s.write(frame({ ok: true, caps: "exec_stream" })));
    });
    server.listen(path.join(dir, "x.sock"));
    cleanups.push(() => server.close());
    const odd = createGuestAgent(() => new Promise((resolve) => { const s = net.createConnection(path.join(dir, "x.sock")); s.once("connect", () => resolve(s)); }), 500);
    await expect(odd.streamInGuest(REQ)).rejects.toMatchObject({ code: "unsupported" });
  });

  it.each([
    ["a token launch as root", { ...REQ, token: true, user: "root" as const }],
    ["an env that names the token variable", { ...REQ, env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }],
    ["an id with a slash", { ...REQ, id: "a/b" }],
    ["an empty id", { ...REQ, id: "" }],
    ["an id of 65 characters", { ...REQ, id: "a".repeat(65) }],
    ["an empty argv", { ...REQ, argv: [] }],
    ["an argv word with a NUL", { ...REQ, argv: ["a\0b"] }],
    ["a zero limit", { ...REQ, timeoutS: 0 }],
    ["a negative limit", { ...REQ, timeoutS: -1 }],
    ["a limit that is not finite", { ...REQ, timeoutS: Number.NaN }],
    ["a limit above a week", { ...REQ, timeoutS: 7 * 24 * 3600 + 1 }],
    ["stdin above the agent's 256 MiB", { ...REQ, stdin: Object.defineProperty(Buffer.alloc(0), "length", { value: (256 << 20) + 1 }) }],
  ])("%s is refused as `bad_request` before any connection", async (_n, req) => {
    const g = fakeGuest();
    await expect(g.agent.streamInGuest(req)).rejects.toMatchObject({ code: "bad_request" });
    expect(g.connects()).toBe(0);
  });

  it("a limit of exactly a week is accepted", async () => {
    const g = fakeGuest();
    g.setStream((sock) => sock.write(exit(0)));
    await drain(await g.agent.streamInGuest({ ...REQ, timeoutS: 7 * 24 * 3600 }));
    expect(g.requests.find((r) => r["op"] === "exec_stream")).toMatchObject({ timeout_s: 7 * 24 * 3600 });
  });

  it("an id of 64 characters is accepted", async () => {
    const g = fakeGuest();
    g.setStream((sock) => sock.write(exit(0)));
    await drain(await g.agent.streamInGuest({ ...REQ, id: "A_-".repeat(21) + "z" }));
  });
});

describe.skipIf(skip)("streamInGuest: reading on demand, and the stream's timers", () => {
  it("a consumer that stops reading stalls the guest: the guest can write only a bounded amount no matter how much it has", async () => {
    const g = fakeGuest();
    const chunk = data(0, Buffer.alloc(65536, 0x62));
    let accepted = 0;
    let stalled: (() => void) | undefined;
    const stalledAt = new Promise<void>((resolve) => (stalled = resolve));
    g.setStream((sock) => {
      let sent = 0;
      const pump = (): void => {
        while (sent < 4000) { // 250 MiB on offer (the seq is not advanced: only the first frame is ever read)
          sent += 1;
          accepted += chunk.length;
          if (!sock.write(chunk)) return void sock.once("drain", pump);
        }
      };
      pump();
      setTimeout(() => stalled?.(), 600);
    });
    const stream = await g.agent.streamInGuest(REQ);
    const it = stream.frames[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false); // one frame read, then the consumer goes away
    await stalledAt;
    const before = accepted;
    await new Promise((r) => setTimeout(r, 300));
    expect(accepted).toBe(before); // nothing more is taken while nobody reads
    expect(accepted).toBeLessThan(8 << 20); // the kernel's buffers and ours, not the 250 MiB on offer
    await it.return?.();
    await expect(stream.done).rejects.toMatchObject({ code: "lost" });
  });

  it("a consumer that is slow for longer than the stream's idle deadline is not timed out (the idle clock runs only while the host waits for the guest)", async () => {
    const g = fakeGuest({ ioTimeoutMs: 100 });
    g.setStream((sock) => sock.write(Buffer.concat([data(0, "a"), data(1, "b"), exit(2)])));
    const stream = await g.agent.streamInGuest({ ...REQ, timeoutS: 0.2 });
    const it = stream.frames[Symbol.asyncIterator]();
    await new Promise((r) => setTimeout(r, 700)); // idle deadline is 0.2 s + 0.1 s
    expect((await it.next()).value).toMatchObject({ data: Buffer.from("a") });
    expect((await it.next()).value).toMatchObject({ data: Buffer.from("b") });
    expect((await it.next()).done).toBe(true);
    expect(await stream.done).toMatchObject({ exit: 0 });
  });

  it("a guest that goes silent ends the stream as `lost` within the idle deadline (the command's limit plus ioTimeoutMs)", async () => {
    const g = fakeGuest({ ioTimeoutMs: 100 });
    g.setStream((sock) => sock.write(data(0, "first"))); // then nothing, and the socket stays open
    const stream = await g.agent.streamInGuest({ ...REQ, timeoutS: 0.3 });
    const t = Date.now();
    const err = await drain(stream).then(() => undefined, (e: unknown) => e);
    expect((err as AgentError).code).toBe("lost");
    expect(Date.now() - t).toBeLessThan(2500);
    expect(await code(stream.done)).toBe("lost");
  });

  it("a guest that never answers the request at all ends the same way", async () => {
    const g = fakeGuest({ ioTimeoutMs: 100 });
    g.setStream(() => undefined);
    const stream = await g.agent.streamInGuest({ ...REQ, timeoutS: 0.2 });
    expect(await code(drain(stream))).toBe("lost");
  });

  it("abort() drops the connection at once, `done` rejects `lost`, and a second abort changes nothing", async () => {
    const g = fakeGuest();
    g.setStream(() => undefined);
    const stream = await g.agent.streamInGuest(REQ);
    stream.abort();
    stream.abort();
    expect(await code(stream.done)).toBe("lost");
    expect(await code(drain(stream))).toBe("lost");
  });

  it("abort() after a clean end changes nothing: `done` stays resolved and the frames stay finished", async () => {
    const g = fakeGuest();
    g.setStream((sock) => sock.write(exit(0)));
    const stream = await g.agent.streamInGuest(REQ);
    await drain(stream);
    stream.abort();
    expect(await stream.done).toMatchObject({ exit: 0 });
    expect(await drain(stream)).toEqual([]);
  });
});

describe.skipIf(skip)("kill: the guest's own `kill` op, on a connection of its own", () => {
  it.each(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"] as const)("sends %s with the stream's id", async (signal) => {
    const g = fakeGuest();
    g.setStream(() => undefined);
    const stream = await g.agent.streamInGuest(REQ);
    await stream.kill(signal);
    expect(g.requests.find((r) => r["op"] === "kill")).toMatchObject({ op: "kill", id: "run-1", signal });
    stream.abort();
  });

  it("a signal outside the guest's four is refused before any connection", async () => {
    const g = fakeGuest();
    g.setStream(() => undefined);
    const stream = await g.agent.streamInGuest(REQ);
    const before = g.connects();
    await expect(stream.kill("SIGSTOP" as never)).rejects.toMatchObject({ code: "bad_request" });
    expect(g.connects()).toBe(before);
    stream.abort();
  });

  it("`unknown_id` for a command that has already ended is a normal answer", async () => {
    const g = fakeGuest();
    g.setKill(() => ({ ok: false, code: "unknown_id", error: "no such command" }));
    g.setStream((sock) => sock.write(exit(0)));
    const stream = await g.agent.streamInGuest(REQ);
    await drain(stream);
    await expect(stream.kill("SIGTERM")).resolves.toBeUndefined();
  });

  it("`unknown_id` once the command has shown output is a normal answer, with no retry", async () => {
    const g = fakeGuest();
    g.setKill(() => ({ ok: false, code: "unknown_id" }));
    g.setStream((sock) => sock.write(data(0, "x")));
    const stream = await g.agent.streamInGuest(REQ);
    await stream.frames[Symbol.asyncIterator]().next();
    await expect(stream.kill("SIGTERM")).resolves.toBeUndefined();
    expect(g.requests.filter((r) => r["op"] === "kill")).toHaveLength(1);
    stream.abort();
  });

  it("`unknown_id` before the stream has shown anything is retried (the agent may not have read the request yet) until the guest knows it", async () => {
    const g = fakeGuest();
    let asked = 0;
    g.setKill(() => (++asked < 3 ? { ok: false, code: "unknown_id" } : { ok: true, signalled: true }));
    g.setStream(() => undefined);
    const stream = await g.agent.streamInGuest(REQ);
    await stream.kill("SIGKILL");
    expect(asked).toBe(3);
    stream.abort();
  });

  it("a kill that the guest never knows ends after the retry bound, and does not throw", async () => {
    const g = fakeGuest();
    g.setKill(() => ({ ok: false, code: "unknown_id" }));
    g.setStream(() => undefined);
    const stream = await g.agent.streamInGuest(REQ);
    const t = Date.now();
    await expect(stream.kill("SIGKILL")).resolves.toBeUndefined();
    expect(Date.now() - t).toBeLessThan(3000);
    stream.abort();
  });

  it.each([["bad_signal"], ["bad_id"], ["something_else"]])("any other refusal (%s) rejects, as `refused`, with none of the guest's words", async (refusal) => {
    const g = fakeGuest();
    g.setKill(() => ({ ok: false, code: refusal, error: "text /secret" }));
    g.setStream(() => undefined);
    const stream = await g.agent.streamInGuest(REQ);
    const err = (await stream.kill("SIGTERM").then(() => undefined, (e: unknown) => e)) as AgentError;
    expect(err.code).toBe("refused");
    expect(err.message).not.toContain("secret");
    stream.abort();
  });

  it("a guest that does not advertise `kill` makes kill() `unsupported`, and sends nothing", async () => {
    const g = fakeGuest({ caps: ["exec_stream"] });
    g.setStream(() => undefined);
    const stream = await g.agent.streamInGuest(REQ);
    await expect(stream.kill("SIGTERM")).rejects.toMatchObject({ code: "unsupported" });
    expect(g.requests.some((r) => r["op"] === "kill")).toBe(false);
    stream.abort();
  });

  it("a kill after the stream has failed sends nothing and resolves", async () => {
    const g = fakeGuest();
    g.setStream((sock) => sock.end());
    const stream = await g.agent.streamInGuest(REQ);
    await drain(stream).catch(() => undefined);
    await expect(stream.kill("SIGKILL")).resolves.toBeUndefined();
    expect(g.requests.some((r) => r["op"] === "kill")).toBe(false);
  });
});

describe.skipIf(skip)("streamInGuest: bytes after the exit frame, however late within the look (the guest keeps its side open)", () => {
  /** A guest that sends the exit frame, does not close when the host ends its side, and sends `late` after `ms`. */
  function lateGuest(ms: number, late: Buffer): FakeGuest {
    const g = fakeGuest();
    g.setStream((sock) => {
      sock.allowHalfOpen = true; // the real agent closes only after the host's FIN; this one keeps listening to show what the host does meanwhile
      sock.write(exit(0));
      setTimeout(() => {
        sock.write(late, () => sock.end());
      }, ms);
    });
    return g;
  }
  it.each([1, 10, 30, 60, 90])("a second exit frame %d ms after the first ends the stream as `lost`, never as a clean end", async (ms) => {
    const g = lateGuest(ms, exit(1));
    const stream = await g.agent.streamInGuest(REQ);
    const err = await drain(stream).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe("lost");
    expect(await code(stream.done)).toBe("lost");
  });
  it.each([1, 10, 30, 60, 90])("a stray byte %d ms after the exit frame ends the stream as `lost`", async (ms) => {
    const g = lateGuest(ms, Buffer.from("x"));
    const stream = await g.agent.streamInGuest(REQ);
    await expect(drain(stream)).rejects.toMatchObject({ code: "lost" });
    expect(await code(stream.done)).toBe("lost");
  });
  it("a guest that stays silent after the exit frame is waited on for the whole 100 ms look, then the end is clean", async () => {
    const g = fakeGuest();
    g.setStream((sock) => {
      sock.allowHalfOpen = true;
      sock.write(exit(0));
    });
    const stream = await g.agent.streamInGuest(REQ);
    const started = performance.now();
    await drain(stream);
    expect(performance.now() - started).toBeGreaterThanOrEqual(95);
    expect(await stream.done).toEqual({ exit: 0, signal: null, timedOut: false });
  });
  it("a guest that closes right after the exit frame ends the stream clean at once (the close is the end of the look)", async () => {
    const g = fakeGuest();
    g.setStream((sock) => sock.end(exit(0)));
    const stream = await g.agent.streamInGuest(REQ);
    const started = performance.now();
    await drain(stream);
    expect(performance.now() - started).toBeLessThan(90);
    expect(await stream.done).toEqual({ exit: 0, signal: null, timedOut: false });
  });
});
