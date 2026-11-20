import { describe, expect, it } from "vitest";
import { WatchState } from "../../src/engineBridge/watchState.js";

const MIN = 60_000;

describe("the watch state", () => {
  it("is unwatched until an until is held, watched until 15 minutes after it, and unwatched again", () => {
    let now = 1_000_000;
    const state = new WatchState(() => now);
    expect(state.watched()).toBe(false);
    state.extend(now + 5 * MIN);
    expect(state.watched()).toBe(true);
    now += 5 * MIN + 15 * MIN - 1;
    expect(state.watched()).toBe(true);
    now += 1;
    expect(state.watched()).toBe(false);
  });

  it("only extends: an earlier until never shortens a watch, a later one lengthens it", () => {
    let now = 0;
    const state = new WatchState(() => now);
    state.extend(10 * MIN);
    state.extend(3 * MIN);
    expect(state.until()).toBe(10 * MIN);
    now = 4 * MIN;
    state.extend(12 * MIN);
    expect(state.until()).toBe(12 * MIN);
  });

  it("holds no until further than ten minutes ahead, whatever it is told", () => {
    const now = 5_000;
    const state = new WatchState(() => now);
    state.extend(now + 30 * 24 * 60 * MIN);
    expect(state.until()).toBe(now + 10 * MIN);
  });

  it("ignores an until that is over, not a number, or infinite: a late or replayed answer starts nothing", () => {
    const now = 5_000_000;
    const state = new WatchState(() => now);
    for (const bad of [now - 1, now, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) state.extend(bad);
    expect(state.until()).toBeNull();
    expect(state.watched()).toBe(false);
  });

  it("a clock that goes back keeps a watch watched, never ends it early", () => {
    let now = 10 * MIN;
    const state = new WatchState(() => now);
    state.extend(now + MIN);
    now -= 5 * MIN;
    expect(state.watched()).toBe(true);
  });
});
