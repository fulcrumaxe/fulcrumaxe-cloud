import { describe, expect, it } from "vitest";
import { WaitAborted, singleFlight, withKeyLock } from "../../src/daemon/keyedLock.js";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe("withKeyLock: a wait that is aborted (D#6 C43-4)", () => {
  it("gives up with WaitAborted, never runs its work, and leaves the turn to the caller behind it", async () => {
    const order: string[] = [];
    const hold = gate();
    const first = withKeyLock("k1", async () => {
      order.push("first");
      await hold.opened;
    });
    const stop = new AbortController();
    const second = withKeyLock("k1", async () => void order.push("second"), stop.signal);
    const third = withKeyLock("k1", async () => void order.push("third"));
    await tick();
    stop.abort();
    await expect(second).rejects.toBeInstanceOf(WaitAborted);
    // The third still waits for the first (the aborted one gave up its place, not the first's turn).
    await tick();
    expect(order).toEqual(["first"]);
    hold.open();
    await first;
    await third;
    expect(order).toEqual(["first", "third"]);
  });

  it("exclusion survives an aborted wait: a caller arriving after it still waits for the holder", async () => {
    const hold = gate();
    const order: string[] = [];
    const holder = withKeyLock("k4", async () => {
      order.push("holder");
      await hold.opened;
      order.push("holder done");
    });
    const stop = new AbortController();
    const waiter = withKeyLock("k4", async () => void order.push("waiter"), stop.signal);
    await tick();
    stop.abort();
    await expect(waiter).rejects.toBeInstanceOf(WaitAborted);
    const late = withKeyLock("k4", async () => void order.push("late"));
    await tick();
    await tick();
    // The holder is still running: the late caller has not started.
    expect(order).toEqual(["holder"]);
    hold.open();
    await holder;
    await late;
    expect(order).toEqual(["holder", "holder done", "late"]);
  });

  it("an abort after the work has started changes nothing", async () => {
    const stop = new AbortController();
    const hold = gate();
    const running = withKeyLock("k2", async () => {
      await hold.opened;
      return "done";
    }, stop.signal);
    await tick();
    stop.abort();
    hold.open();
    expect(await running).toBe("done");
  });

  it("an already-aborted signal does not run the work even when nobody holds the key", async () => {
    const stop = new AbortController();
    stop.abort();
    let ran = false;
    await expect(withKeyLock("k3", async () => void (ran = true), stop.signal)).rejects.toBeInstanceOf(WaitAborted);
    expect(ran).toBe(false);
    // And the key is free again.
    expect(await withKeyLock("k3", async () => "ok")).toBe("ok");
  });
});

describe("singleFlight: a waiter that is aborted", () => {
  it("stops waiting; the flight and the other waiters carry on", async () => {
    const hold = gate();
    let runs = 0;
    const work = async (): Promise<string> => {
      runs += 1;
      await hold.opened;
      return "built";
    };
    const stop = new AbortController();
    const owner = singleFlight("f1", work);
    const patient = singleFlight("f1", work);
    const impatient = singleFlight("f1", work, stop.signal);
    await tick();
    stop.abort();
    await expect(impatient).rejects.toBeInstanceOf(WaitAborted);
    hold.open();
    expect(await owner).toEqual({ value: "built", shared: false });
    expect(await patient).toEqual({ value: "built", shared: true });
    expect(runs).toBe(1);
  });

  it("the caller that runs the work can also stop waiting, without cancelling the work", async () => {
    const hold = gate();
    let finished = false;
    const stop = new AbortController();
    const owner = singleFlight("f2", async () => {
      await hold.opened;
      finished = true;
      return 1;
    }, stop.signal);
    await tick();
    stop.abort();
    await expect(owner).rejects.toBeInstanceOf(WaitAborted);
    hold.open();
    await tick();
    await tick();
    expect(finished).toBe(true);
  });
});
