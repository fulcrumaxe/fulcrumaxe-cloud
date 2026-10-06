import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNNER_QUEUE_TTL_MS } from "@fx/runner";
import { RUNNER_PENDING_CEILING_MS, RUNNER_PENDING_MARGIN_MS, WaitBudget } from "../src/plan/waitBudget.js";

/** D#6 C12 A3: the wait budget that stops counting while the run is pending. */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function budget(ms: number) {
  const expired = vi.fn();
  return { expired, b: new WaitBudget(ms, expired) };
}

describe("WaitBudget", () => {
  it("is a plain timeout when nothing pauses it", () => {
    const { b, expired } = budget(1000);
    vi.advanceTimersByTime(999);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
    b.cancel();
  });

  it("does not count paused time: paused for a day, it still has the time it had left", () => {
    const { b, expired } = budget(1000);
    vi.advanceTimersByTime(400);
    b.pause();
    vi.advanceTimersByTime(24 * 3600_000);
    expect(expired).not.toHaveBeenCalled();
    b.resume();
    vi.advanceTimersByTime(599);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("accumulates across several pauses", () => {
    const { b, expired } = budget(1000);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(200);
      b.pause();
      vi.advanceTimersByTime(10_000);
      b.resume();
    }
    vi.advanceTimersByTime(199);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
    b.cancel();
  });

  it("pause and resume are idempotent: a second pause does not lose time, a second resume does not restart the clock", () => {
    const { b, expired } = budget(1000);
    vi.advanceTimersByTime(300);
    b.pause();
    b.pause();
    vi.advanceTimersByTime(5000);
    b.resume();
    vi.advanceTimersByTime(300);
    b.resume();
    vi.advanceTimersByTime(399);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("fires once, and a pause or resume after it fired does nothing", () => {
    const { b, expired } = budget(100);
    vi.advanceTimersByTime(100);
    b.pause();
    b.resume();
    vi.advanceTimersByTime(10_000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("cancel stops it for good, even after a pause and resume, and is safe twice", () => {
    const { b, expired } = budget(100);
    b.cancel();
    b.cancel();
    b.resume();
    vi.advanceTimersByTime(10_000);
    expect(expired).not.toHaveBeenCalled();
    const second = budget(100);
    second.b.pause();
    second.b.cancel();
    second.b.resume();
    vi.advanceTimersByTime(10_000);
    expect(second.expired).not.toHaveBeenCalled();
  });

  it("leaves no timer behind once cancelled (paused, it holds only the one timer that caps the pause)", () => {
    const { b } = budget(1000);
    b.pause();
    expect(vi.getTimerCount()).toBe(1);
    b.resume();
    expect(vi.getTimerCount()).toBe(1);
    b.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("the cap on paused time", () => {
    it("the ceiling is the runner queue TTL plus a fixed margin", () => {
      expect(RUNNER_PENDING_CEILING_MS).toBe(RUNNER_QUEUE_TTL_MS + RUNNER_PENDING_MARGIN_MS);
      expect(RUNNER_PENDING_MARGIN_MS).toBeGreaterThan(0);
    });

    it("a budget paused past the ceiling expires like a normal timeout", () => {
      const { b, expired } = budget(1000);
      vi.advanceTimersByTime(100);
      b.pause();
      vi.advanceTimersByTime(RUNNER_PENDING_CEILING_MS - 1);
      expect(expired).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(expired).toHaveBeenCalledTimes(1);
      b.resume(); // nothing restarts after it expired
      vi.advanceTimersByTime(10 * RUNNER_PENDING_CEILING_MS);
      expect(expired).toHaveBeenCalledTimes(1);
    });

    it("the cap is on the total of all pauses: several shorter pauses add up", () => {
      const expired = vi.fn();
      const b = new WaitBudget(1000, expired, Date.now, 5000);
      for (let i = 0; i < 4; i++) {
        b.pause();
        vi.advanceTimersByTime(1000);
        b.resume();
        vi.advanceTimersByTime(10);
      }
      expect(expired).not.toHaveBeenCalled();
      b.pause();
      vi.advanceTimersByTime(999);
      expect(expired).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(expired).toHaveBeenCalledTimes(1);
    });
  });
});
