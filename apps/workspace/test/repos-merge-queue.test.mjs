// D#694 B7-2: the Repos app's merge queue line and help block. The view is built by the shared h() against a small stand-in for the DOM calls it makes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUEUE_ABOUT, QUEUE_HELP, QUEUE_LINE, QUEUE_RETRY, queueState, queueView } from "../apps/repos/repos-runners.js";

class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.kids = []; this.on = {}; this.className = ""; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { this.on[t] = f; }
  appendChild(c) { this.kids.push(c); return c; }
  get textContent() { return this.kids.map((k) => (k instanceof FakeEl ? k.textContent : k.text)).join(""); }
}
const findAll = (el, test, out = []) => (test(el) && out.push(el), el.kids.forEach((k) => k instanceof FakeEl && findAll(k, test, out)), out);
const byId = (root, id) => findAll(root, (e) => e.getAttribute("data-testid") === id);

beforeEach(() => {
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }) });
});
afterEach(() => vi.unstubAllGlobals());

const view = (settings, over = {}) => queueView(settings, { open: false, onToggle: () => {}, onRetry: () => {}, ...over });
const lineOf = (el) => byId(el, "repos-queue-line")[0];

describe("the merge queue line", () => {
  it.each([
    [{ merge_queue: { state: "on" } }, "on", "Merge queue: on (GitHub merges for you once it is queued)"],
    [{ merge_queue: { state: "off" } }, "off", "Merge queue: off"],
    [{ merge_queue: { state: "runner" } }, "runner", "Merge queue: your runner handles merges for this repository."],
    [{ merge_queue: { state: "unreadable" } }, "unreadable", "Merge queue: could not be read"],
  ])("shows exactly one of the four sentences for %j", (settings, state, sentence) => {
    expect(QUEUE_LINE[state]).toBe(sentence);
    const line = lineOf(view(settings));
    expect(line.getAttribute("data-state")).toBe(state);
    expect(line.textContent.startsWith(sentence)).toBe(true);
    expect(line.textContent).not.toMatch(/null|undefined|NaN|\[object/);
  });

  it.each([[{}], [{ merge_queue: null }], [{ merge_queue: {} }], [{ merge_queue: { state: "maybe" } }], [{ merge_queue: { state: "ON" } }], [{ merge_queue: "on" }], [null], [undefined]])(
    "a response with the field missing or odd (%j) reads \"could not be read\", never off",
    (settings) => {
      expect(queueState(settings)).toBe("unreadable");
      expect(lineOf(view(settings)).textContent.startsWith("Merge queue: could not be read")).toBe(true);
    },
  );

  it("offers Try again only when it could not be read, and the link re-fetches the settings", () => {
    const onRetry = vi.fn();
    const unreadable = view({}, { onRetry });
    const retry = byId(unreadable, "repos-queue-retry");
    expect(retry.map((e) => e.textContent)).toEqual([QUEUE_RETRY]);
    retry[0].on.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    for (const state of ["on", "off", "runner"]) expect(byId(view({ merge_queue: { state } }), "repos-queue-retry")).toHaveLength(0);
    const runner = view({ merge_queue: { state: "runner" } });
    expect(lineOf(runner).textContent).not.toContain(QUEUE_RETRY);
    expect(byId(runner, "repos-queue-about")).toHaveLength(1); // the help link stays
  });
});

describe("the help block", () => {
  it("is collapsed by default, opened by the About link, and the link says which", () => {
    const onToggle = vi.fn();
    const closed = view({ merge_queue: { state: "on" } }, { onToggle });
    expect(byId(closed, "repos-queue-help")).toHaveLength(0);
    const about = byId(closed, "repos-queue-about")[0];
    expect(about.textContent).toBe(QUEUE_ABOUT);
    expect(about.getAttribute("aria-expanded")).toBe("false");
    about.on.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    const open = view({ merge_queue: { state: "on" } }, { open: true });
    expect(byId(open, "repos-queue-about")[0].getAttribute("aria-expanded")).toBe("true");
    expect(byId(open, "repos-queue-help")).toHaveLength(1);
  });

  it("pins its headings and says the promised things in plain words", () => {
    const help = byId(view({}, { open: true }), "repos-queue-help")[0];
    expect(findAll(help, (e) => e.tag === "h4").map((e) => e.textContent)).toEqual([
      "What the product does",
      "Your CI must run on merge_group",
      "Permissions",
      "Human merge only",
      "Taking a pull request out",
      "In GitHub's merge queue",
      "How fresh this line is",
    ]);
    const text = help.textContent;
    for (const phrase of [
      "queues the pull request instead of merging it, whenever the repository has a merge queue. There is nothing to turn on.",
      "must run on `merge_group`, or queue entries never get checks",
      "removes the entry when its timeout passes",
      "GitHub removed it from the merge queue",
      "needs no extra GitHub App permission",
      "still wins: nothing is queued while it is on",
      "Remove from queue",
      "In GitHub's merge queue",
      "at most once every 5 minutes",
    ]) expect(text).toContain(phrase);
    expect(text).not.toMatch(/null|undefined|NaN|\[object/);
    expect(QUEUE_HELP.every((b) => b.heading.length > 0 && b.text.length > 0)).toBe(true);
  });
});
