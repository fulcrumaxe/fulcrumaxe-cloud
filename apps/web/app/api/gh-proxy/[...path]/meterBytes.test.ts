import { describe, expect, it } from "vitest";
import { meterBytes, type MeterBytesDeps } from "./handler";

const CHECKPOINT = 100;
const CHUNK = 40;

/** A stand-in for the database counter with the contract of the budget function: the answer is spent once the total reaches the limit. */
function counter(limit: number) {
  let total = 0;
  const calls: number[] = [];
  return {
    record: async (n: number): Promise<boolean | null> => {
      calls.push(n);
      total += n;
      return total >= limit;
    },
    total: () => total,
    calls,
  };
}

function setup(limit: number) {
  const c = counter(limit);
  const deferred: Promise<unknown>[] = [];
  const aborts: string[] = [];
  const deps: MeterBytesDeps = {
    record: c.record,
    defer: (work) => void deferred.push(work),
    onAbort: (reason) => void aborts.push(reason),
    checkpoint: CHECKPOINT,
  };
  return { c, deferred, aborts, deps };
}

/** A source of `chunks` chunks of CHUNK bytes; an endless one never closes. */
function source(chunks: number | "endless") {
  let sent = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (chunks !== "endless" && sent >= chunks) {
          controller.close();
          return;
        }
        sent++;
        controller.enqueue(new Uint8Array(CHUNK));
      },
    },
    { highWaterMark: 0 },
  );
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<{ sent: number; failure?: unknown }> {
  const reader = stream.getReader();
  let sent = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { sent };
      sent += value.byteLength;
    }
  } catch (failure) {
    return { sent, failure };
  }
}

describe("meterBytes", () => {
  it("adds to the count at every checkpoint and sends the remainder through defer when the response ends", async () => {
    const t = setup(Number.MAX_SAFE_INTEGER);
    // 7 chunks of 40 = 280 bytes. A checkpoint is reached at 120 (3 chunks) and again at 240 (6 chunks); the remainder is 40.
    const out = await drain(meterBytes(source(7), t.deps)!);
    expect(out).toEqual({ sent: 280 });
    // The two checkpoints were awaited inside the stream; the remainder (40) was handed to defer, not awaited.
    expect(t.deferred).toHaveLength(1);
    await Promise.all(t.deferred);
    expect(t.c.calls).toEqual([120, 120, 40]);
    expect(t.c.total()).toBe(280);
  });

  it("adds nothing at the end of a response that ended exactly on a checkpoint, and nothing for an empty one", async () => {
    const t = setup(Number.MAX_SAFE_INTEGER);
    const exact = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(CHECKPOINT));
        controller.close();
      },
    });
    expect(await drain(meterBytes(exact, t.deps)!)).toEqual({ sent: CHECKPOINT });
    expect(await drain(meterBytes(new ReadableStream<Uint8Array>({ start: (c) => c.close() }), t.deps)!)).toEqual({ sent: 0 });
    expect(t.c.calls).toEqual([CHECKPOINT]);
    expect(t.deferred).toHaveLength(0);
  });

  it("ends the stream with an error at the first checkpoint that answers spent, without sending the chunk that reached it", async () => {
    const t = setup(200);
    // The first checkpoint (120 bytes, total 120 < 200) is open; the second (total 240 >= 200) is spent.
    const out = await drain(meterBytes(source("endless"), t.deps)!);
    expect(out.sent).toBe(200);
    expect((out.failure as Error).message).toBe("clone_bytes_limited");
    expect(t.c.calls).toEqual([120, 120]);
    expect(t.aborts).toEqual(["spent"]);
    // Everything that was sent is counted, and the aborted stream adds no remainder.
    expect(t.c.total()).toBeGreaterThanOrEqual(out.sent);
    expect(t.deferred).toHaveLength(0);
  });

  it("fails closed when a checkpoint cannot be counted", async () => {
    const t = setup(Number.MAX_SAFE_INTEGER);
    t.deps.record = async () => null;
    const out = await drain(meterBytes(source(20), t.deps)!);
    expect(out.sent).toBe(80);
    expect((out.failure as Error).message).toBe("clone_bytes_limited");
    expect(t.aborts).toEqual(["uncounted"]);
  });

  it("counts the bytes already sent when the reader cuts the response off, through defer", async () => {
    const t = setup(Number.MAX_SAFE_INTEGER);
    const reader = meterBytes(source("endless"), t.deps)!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    expect(t.deferred).toHaveLength(1);
    await Promise.all(t.deferred);
    expect(t.c.total()).toBe(80);
  });

  it("keeps the checkpoints it already counted when the stream is never finished or cancelled (the function is killed)", async () => {
    const t = setup(Number.MAX_SAFE_INTEGER);
    const reader = meterBytes(source("endless"), t.deps)!.getReader();
    let sent = 0;
    // 8 chunks = 320 bytes sent; then the reader is simply abandoned: no cancel, no close, no further pull.
    for (let i = 0; i < 8; i++) sent += (await reader.read()).value!.byteLength;
    expect(sent).toBe(320);
    expect(t.deferred).toHaveLength(0);
    // The two checkpoints passed (120 bytes each, at 3 and 6 chunks) stay counted, and the 7th chunk's checkpoint was not reached:
    // at most one checkpoint's worth of sent bytes is not counted.
    expect(t.c.total()).toBe(240);
    expect(sent - t.c.total()).toBeLessThan(CHECKPOINT);
  });

  it("lets N concurrent streams overrun the allowance by at most N checkpoints", async () => {
    const limit = 1000;
    const t = setup(limit);
    const N = 5;
    // Each stream passed the start-of-request check (the count was 0), then they all stream at once.
    const outs = await Promise.all(Array.from({ length: N }, () => drain(meterBytes(source("endless"), t.deps)!)));
    const sent = outs.reduce((sum, o) => sum + o.sent, 0);
    for (const o of outs) expect((o.failure as Error).message).toBe("clone_bytes_limited");
    // What was sent is never more than the allowance plus what N streams can send between a checkpoint and the answer to it.
    expect(sent).toBeLessThanOrEqual(limit + N * (CHECKPOINT + CHUNK));
    expect(t.aborts).toHaveLength(N);
  });
});
