import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WaitBudget } from "../src/plan/waitBudget.js";

/** D#6 C29: a wait budget can be told how much of it a run already spent before this call began. */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function budget(ms: number) {
  const expired = vi.fn();
  return { expired, b: new WaitBudget(ms, expired) };
}

describe("WaitBudget.consume", () => {
  it("takes already-spent time off a running budget and re-arms the timer for what is left", () => {
    const { b, expired } = budget(360_000);
    vi.advanceTimersByTime(1_000); // time this call already ran
    b.consume(240_000);
    vi.advanceTimersByTime(118_999);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
    b.cancel();
  });

  it("takes it off a paused budget too: when it resumes it has what the run had left", () => {
    const { b, expired } = budget(360_000);
    b.pause();
    b.consume(240_000);
    vi.advanceTimersByTime(3_600_000);
    expect(expired).not.toHaveBeenCalled();
    b.resume();
    vi.advanceTimersByTime(119_999);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
    b.cancel();
  });

  it("a credit larger than the budget expires it, once", () => {
    const { b, expired } = budget(1_000);
    b.consume(5_000);
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("ignores zero, negative and non-finite credits, and a finished budget", () => {
    const { b, expired } = budget(1_000);
    for (const ms of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) b.consume(ms);
    vi.advanceTimersByTime(999);
    expect(expired).not.toHaveBeenCalled();
    b.cancel();
    b.consume(10_000);
    vi.advanceTimersByTime(10_000);
    expect(expired).not.toHaveBeenCalled();
  });
});
