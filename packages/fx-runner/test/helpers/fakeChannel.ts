import { duplexPair, type Duplex } from "node:stream";

/**
 * A stand-in for the engine session's supervisor on the far end of the channel, built to the contract (guestSession.ts): ONE request per connection, a 4-byte big-endian length and that many bytes of JSON, then, for
 * `token_put`, exactly `size` raw bytes; the reply is one frame and the end of the stream. Every connection is a fresh in-memory pair, so a test needs no socket and the host's network is never touched. `answer` sees each
 * request (the header, and the raw bytes of a `token_put`) and returns the reply body; it may throw to model a peer that goes away without a word.
 */
export interface FakeChannel {
  connect: () => Promise<Duplex>;
  requests: Array<{ header: Record<string, unknown>; body?: Buffer }>;
  connections: () => number;
}

export function fakeChannel(answer: (header: Record<string, unknown>, body?: Buffer) => unknown): FakeChannel {
  const requests: FakeChannel["requests"] = [];
  let connections = 0;
  return {
    requests,
    connections: () => connections,
    connect: async () => {
      connections++;
      const [client, server] = duplexPair();
      let buf = Buffer.alloc(0);
      let answered = false;
      server.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (answered || buf.length < 4) return;
        const length = buf.readUInt32BE(0);
        if (buf.length < 4 + length) return;
        const header = JSON.parse(buf.subarray(4, 4 + length).toString("utf8")) as Record<string, unknown>;
        const size = header["op"] === "token_put" ? (header["size"] as number) : 0;
        if (buf.length < 4 + length + size) return;
        answered = true;
        const body = size > 0 ? Buffer.from(buf.subarray(4 + length, 4 + length + size)) : undefined;
        requests.push({ header, ...(body === undefined ? {} : { body }) });
        try {
          const out = Buffer.from(JSON.stringify(answer(header, body)));
          const frame = Buffer.alloc(4 + out.length);
          frame.writeUInt32BE(out.length, 0);
          out.copy(frame, 4);
          server.end(frame);
        } catch {
          server.end(); // a peer that goes away without a word
        }
      });
      return client;
    },
  };
}
