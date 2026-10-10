// apps/workspace/test/pipeline-storage.test.mjs
//
// D#37 WS-F1a: the Pipeline board's data side, against a fake get(), a fake
// on()/onRefresh() and vitest's fake clock. The contract fixtures are the
// bodies the fake server returns.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STAGES, COLUMNS, KIND_LABELS, POLL_MS, columnOf, createBoard, getAllPages, groupByColumn, isUuid, itemHeading, kindLabel, sameItems, verdictFor } from "../apps/pipeline/pipeline-storage.js";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const PAGE = fx("listWorkItems", "200-page.json");
const IN_REVIEW = fx("getWorkItem", "200-in-review.json");
const NEEDS_HUMAN = fx("getWorkItem", "200-needs-human.json");
const REPOS_RAW = fx("listRepos", "200-page.json");
// The fixture's second repo (the work item's) has no full name; this copy gives it one, as an installed repo has.
const REPOS = { ...REPOS_RAW, data: REPOS_RAW.data.map((r) => (r.product === "docs" ? { ...r, full_name: "acme/docs" } : r)) };
const ID = PAGE.data[0].id;
const OTHER = "55555555-5555-4555-8555-555555555555";

const fail = (status) => Object.assign(new Error("x"), { status });
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** A fake get(): routes is path -> body | Error | function(url). Logs every call. */
function fakeGet(routes) {
  const calls = [];
  const get = async (method, url) => {
    calls.push(`${method} ${url}`);
    const r = routes[url.split("?")[0]];
    const out = typeof r === "function" ? r(url) : r;
    if (out instanceof Error) throw out;
    if (out === undefined) throw fail(404);
    return structuredClone(out);
  };
  get.calls = calls;
  get.count = (prefix) => calls.filter((c) => c.startsWith("GET " + prefix)).length;
  return get;
}

/** A fake live client: on() and onRefresh() record handlers and hand back a disposer. */
function fakeLive() {
  const subs = new Map();
  const refresh = new Set();
  return {
    on: (type, fn) => {
      if (!subs.has(type)) subs.set(type, new Set());
      subs.get(type).add(fn);
      return () => subs.get(type).delete(fn);
    },
    onRefresh: (fn) => (refresh.add(fn), () => refresh.delete(fn)),
    emit: (type, data) => (subs.get(type) || []).forEach((fn) => fn({ id: "e", type, data })),
    refresh: () => [...refresh].forEach((fn) => fn()),
    count: () => refresh.size + [...subs.values()].reduce((n, s) => n + s.size, 0),
    types: () => [...subs.keys()].sort(),
  };
}

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

describe("columns and verdicts", () => {
  it("lists the nine columns in order and puts the three closed stages in Done", () => {
    expect(COLUMNS.map((c) => c.label)).toEqual([
      "Triaged", "Discussing", "Spec ready", "In progress", "PR opened",
      "Changes requested", "Review passed", "Needs a person", "Done",
    ]);
    for (const s of ["merged", "closed_unmerged", "closed"]) expect(columnOf(s)).toBe("done");
    expect(columnOf("in_progress")).toBe("in_progress");
  });

  it("puts a card with an unknown stage in no column and logs nothing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const groups = groupByColumn([{ ...PAGE.data[0], stage: "from_the_future" }]);
    expect(columnOf("from_the_future")).toBeNull();
    expect(Object.values(groups).flat()).toEqual([]);
    expect(err).not.toHaveBeenCalled();
  });

  it("derives the verdict line from the stage alone", () => {
    expect(verdictFor("changes_requested")).toBe("Review asked for changes");
    expect(verdictFor("review_passed")).toBe("Review passed");
    expect(verdictFor("needs_human")).toBe("Needs a person");
    for (const s of ["triaged", "discussing", "spec_ready", "in_progress", "pr_opened", "merged", "closed_unmerged", "closed"]) {
      expect(verdictFor(s)).toBeNull();
    }
  });

  it("groups the listWorkItems and getWorkItem fixtures", () => {
    const groups = groupByColumn([...PAGE.data, { ...IN_REVIEW, id: OTHER }]);
    expect(groups.in_progress.map((i) => i.id)).toEqual([ID]);
    expect(groups.changes_requested.map((i) => i.id)).toEqual([OTHER]);
  });
});

describe("loading", () => {
  it("follows next_cursor to the end, once per page", async () => {
    const get = fakeGet({
      "/api/v1/work-items": (url) =>
        url.includes("cursor=c2") ? { data: [{ ...PAGE.data[0], id: OTHER }], next_cursor: null } : { data: PAGE.data, next_cursor: "c2" },
    });
    expect((await getAllPages("/api/v1/work-items", get)).map((i) => i.id)).toEqual([ID, OTHER]);
    expect(get.calls).toEqual(["GET /api/v1/work-items", "GET /api/v1/work-items?cursor=c2"]);
  });

  it("stops if the server repeats a cursor", async () => {
    const get = fakeGet({ "/api/v1/work-items": { data: [], next_cursor: "same" } });
    await getAllPages("/api/v1/work-items", get);
    expect(get.calls).toHaveLength(2);
  });

  it("loads the list once and the repos once, and labels cards by the repo's full name, never its product", async () => {
    const get = fakeGet({ "/api/v1/work-items": PAGE, "/api/v1/repos": REPOS });
    const board = createBoard({ get });
    await board.load();
    const st = board.getState();
    expect(st.status).toBe("ready");
    expect(st.items.size).toBe(1);
    expect(st.repos.get(PAGE.data[0].repo_id)).toBe("acme/docs");
    expect(st.repos.get("33333333-3333-4333-8333-333333333333")).toBe("acme/widgets");
    expect([...st.repos.values()]).not.toContain("docs");
    expect(get.count("/api/v1/work-items")).toBe(1);
    expect(get.count("/api/v1/repos")).toBe(1);
  });

  it("a repo with no full name is left out, so its cards fall back to #N rather than the product label", async () => {
    const board = createBoard({ get: fakeGet({ "/api/v1/work-items": PAGE, "/api/v1/repos": REPOS_RAW }) });
    await board.load();
    expect(board.getState().repos.has(PAGE.data[0].repo_id)).toBe(false);
    expect(itemHeading(PAGE.data[0], board.getState().repos)).toMatchObject({ repo: null, number: "#42" });
  });

  describe("itemHeading", () => {
    const repos = new Map([["r1", "fulcrumaxe/cloud"]]);
    const base = { repo_id: "r1", kind: "bug", issue_number: 595, title: "Cards only say team #595" };
    it("gives the repo's full name, the number and the title", () => {
      expect(itemHeading(base, repos)).toEqual({ repo: "fulcrumaxe/cloud", number: "#595", title: "Cards only say team #595", kind: "Bug" });
    });
    it("falls back to the number alone when the repo is not loaded", () => {
      expect(itemHeading(base, new Map())).toMatchObject({ repo: null, number: "#595" });
      expect(itemHeading({ ...base, repo_id: null }, repos).repo).toBeNull();
    });
    it("with no title shows the kind in plain words plus the number, never empty or null", () => {
      for (const title of [null, undefined, "", "   ", "\u0007\n\t", 42, {}]) {
        expect(itemHeading({ ...base, title }, repos).title).toBe("Bug #595");
      }
      expect(itemHeading({ ...base, title: null, kind: "small" }, repos).title).toBe("Small change #595");
      expect(itemHeading({ ...base, title: null, kind: "feature", issue_number: null }, repos)).toMatchObject({ title: "Feature", number: "" });
      expect(itemHeading({ repo_id: null, kind: null, issue_number: null, title: null }, repos).title).toBe("Work item");
    });
    it("names every kind the pipeline uses and an unknown or inherited one as Work item", () => {
      expect(Object.keys(KIND_LABELS)).toEqual(expect.arrayContaining(["feature", "critical", "small", "bug", "doc", "process", "review", "other", "issue", "discussion"]));
      for (const k of ["toString", "__proto__", "constructor", "nope", "", 7]) expect(kindLabel(k)).toBe("Work item");
    });
    it("a hostile title stays plain text: markup is kept as characters, control characters and newlines become spaces, length is bounded", () => {
      const hostile = '<img src=x onerror="alert(1)">\u0000\u001b[31m\r\nline two\u0085<script>x</script>';
      const out = itemHeading({ ...base, title: hostile }, repos).title;
      expect(out).toBe('<img src=x onerror="alert(1)"> [31m line two <script>x</script>');
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(out)).toBe(false);
      expect(Array.from(itemHeading({ ...base, title: "é".repeat(500) }, repos).title)).toHaveLength(160);
    });
  });

  it("still renders the board when the repos request fails", async () => {
    const board = createBoard({ get: fakeGet({ "/api/v1/work-items": PAGE, "/api/v1/repos": fail(500) }) });
    await board.load();
    expect(board.getState().status).toBe("ready");
    expect(board.getState().repos.size).toBe(0);
    expect(board.getState().items.size).toBe(1);
  });

  it("reports an error when the list fails, whatever the status", async () => {
    for (const status of [401, 500, 0]) {
      const board = createBoard({ get: fakeGet({ "/api/v1/work-items": fail(status), "/api/v1/repos": REPOS }) });
      await board.load();
      expect(board.getState().status).toBe("error");
    }
  });

  it("keeps the board showing when a later list load fails", async () => {
    let bad = false;
    const get = fakeGet({ "/api/v1/work-items": () => (bad ? fail(500) : PAGE), "/api/v1/repos": REPOS });
    const board = createBoard({ get });
    const live = fakeLive();
    board.connectLive(live);
    await board.load();
    bad = true;
    live.emit("run.status_changed", { runId: OTHER });
    await tick();
    expect(board.getState().status).toBe("ready");
    expect(board.getState().items.size).toBe(1);
  });
});

describe("live events (criterion 4)", () => {
  async function ready(routes = {}) {
    const get = fakeGet({ "/api/v1/work-items": PAGE, "/api/v1/repos": REPOS, ...routes });
    const board = createBoard({ get });
    const live = fakeLive();
    board.connectLive(live);
    await board.load();
    return { get, board, live };
  }
  const stageOf = (board, id) => board.getState().items.get(id)?.stage;

  it("subscribes to exactly the five things the mapping names", async () => {
    const { live } = await ready();
    expect(live.types()).toEqual(["pr.opened", "run.status_changed", "work_item.needs_human", "work_item.stage_changed"]);
    expect(live.count()).toBe(5); // four event types plus onRefresh
  });

  it("work_item.stage_changed (every move the driver records) reads the item once and moves the card by the RETURNED stage, never the event's own", async () => {
    const { get, board, live } = await ready({ [`/api/v1/work-items/${ID}`]: NEEDS_HUMAN });
    expect(stageOf(board, ID)).toBe("in_progress");
    live.emit("work_item.stage_changed", { workItemId: ID, fromStage: "in_progress", toStage: "merged" });
    await tick();
    expect(stageOf(board, ID)).toBe("needs_human");
    expect(get.calls.filter((c) => c === `GET /api/v1/work-items/${ID}`)).toHaveLength(1);
    live.emit("work_item.stage_changed", { fromStage: "a", toStage: "b" });
    live.emit("work_item.stage_changed", { workItemId: "not-a-uuid" });
    await tick();
    expect(get.calls.filter((c) => c === `GET /api/v1/work-items/${ID}`)).toHaveLength(1);
  });

  it("work_item.needs_human reads the item once and moves the card by the RETURNED stage", async () => {
    const { get, board, live } = await ready({ [`/api/v1/work-items/${ID}`]: NEEDS_HUMAN });
    expect(stageOf(board, ID)).toBe("in_progress");
    live.emit("work_item.needs_human", { workItemId: ID, sourceRunId: OTHER });
    await tick();
    expect(get.calls.filter((c) => c === `GET /api/v1/work-items/${ID}`)).toHaveLength(1);
    expect(stageOf(board, ID)).toBe("needs_human");
  });

  it("pr.opened ignores the event's own stage", async () => {
    const { board, live } = await ready({ [`/api/v1/work-items/${ID}`]: { ...NEEDS_HUMAN, stage: "pr_opened", updated_at: "2026-09-18T12:31:00.000Z" } });
    live.emit("pr.opened", { workItemId: ID, prNumber: 7, stage: "merged" });
    await tick();
    expect(stageOf(board, ID)).toBe("pr_opened");
  });

  it("adds an id that is not on the board", async () => {
    const { board, live } = await ready({ [`/api/v1/work-items/${OTHER}`]: { ...NEEDS_HUMAN, id: OTHER } });
    live.emit("pr.opened", { workItemId: OTHER });
    await tick();
    expect(board.getState().items.has(OTHER)).toBe(true);
  });

  it("a 404 removes the card if it is there, and does nothing otherwise", async () => {
    const { board, live } = await ready();
    live.emit("work_item.needs_human", { workItemId: OTHER });
    await tick();
    expect(board.getState().items.size).toBe(1);
    live.emit("work_item.needs_human", { workItemId: ID });
    await tick();
    expect(board.getState().items.size).toBe(0);
  });

  it("ignores an event without a valid workItemId UUID", async () => {
    const { get, live } = await ready();
    const before = get.calls.length;
    for (const data of [undefined, {}, { workItemId: "" }, { workItemId: 7 }, { workItemId: "../timeline" }, { workItemId: ID + "x" }]) {
      live.emit("pr.opened", data);
      live.emit("work_item.needs_human", data);
    }
    await tick();
    expect(get.calls.length).toBe(before);
    expect(isUuid(ID)).toBe(true);
  });

  it("run.status_changed re-loads the list and not the repos", async () => {
    const { get, live } = await ready();
    live.emit("run.status_changed", { runId: OTHER, from: "queued", to: "running" });
    await tick();
    expect(get.count("/api/v1/work-items")).toBe(2);
    expect(get.count("/api/v1/repos")).toBe(1);
  });

  it("refresh re-loads the list and the repos", async () => {
    const { get, live } = await ready();
    live.refresh();
    await tick();
    expect(get.count("/api/v1/work-items")).toBe(2);
    expect(get.count("/api/v1/repos")).toBe(2);
  });

  it("coalesces: five triggers inside one second make at most two list loads", async () => {
    const { get, live } = await ready();
    const before = get.count("/api/v1/work-items");
    for (let i = 0; i < 5; i++) {
      live.emit("run.status_changed", {});
      await tick(100);
    }
    await tick(2000);
    expect(get.count("/api/v1/work-items") - before).toBe(2);
    live.emit("run.status_changed", {}); // a quiet board loads again at once
    await tick();
    expect(get.count("/api/v1/work-items") - before).toBe(3);
  });

  it("does not let an older list overwrite a newer item", async () => {
    const { board, live } = await ready({ [`/api/v1/work-items/${ID}`]: NEEDS_HUMAN });
    live.emit("work_item.needs_human", { workItemId: ID });
    await tick();
    expect(stageOf(board, ID)).toBe("needs_human");
    live.emit("run.status_changed", {}); // the list still says in_progress, dated earlier
    await tick();
    expect(stageOf(board, ID)).toBe("needs_human");
  });

  it("drops every subscription on destroy and ignores late replies", async () => {
    const { board, live } = await ready({ [`/api/v1/work-items/${ID}`]: NEEDS_HUMAN });
    live.emit("work_item.needs_human", { workItemId: ID });
    board.destroy();
    await tick(5000);
    expect(live.count()).toBe(0);
    expect(stageOf(board, ID)).toBe("in_progress");
  });

  it("20 open/close cycles leave the subscription count at its baseline", async () => {
    const live = fakeLive();
    const baseline = live.count();
    for (let i = 0; i < 20; i++) {
      const board = createBoard({ get: fakeGet({ "/api/v1/work-items": PAGE, "/api/v1/repos": REPOS }) });
      board.connectLive(live);
      await board.load();
      board.destroy();
    }
    expect(live.count()).toBe(baseline);
  });
});

describe("the polling fallback (a lost live connection must not leave the board stale)", () => {
  const moved = (page, id, stage, at = "2026-09-18T13:00:00.000Z") => ({ ...page, data: page.data.map((i) => (i.id === id ? { ...i, stage, updated_at: at } : i)) });
  const countReads = (get) => get.calls.filter((c) => c.startsWith("GET /api/v1/work-items") && !c.includes("/work-items/")).length;

  async function polling(over = {}) {
    let page = PAGE;
    const get = fakeGet({ "/api/v1/work-items": () => page, "/api/v1/repos": REPOS });
    const changes = [];
    const board = createBoard({ get, onChange: (st) => changes.push(st), ...over });
    const live = fakeLive();
    board.connectLive(live); // the live client is connected, and says nothing
    await board.load();
    changes.length = 0;
    return { get, board, live, changes, setPage: (p) => (page = p) };
  }

  it("is 20 seconds, and the active stages are the ones before a merge or a hand-over", () => {
    expect(POLL_MS).toBe(20000);
    expect([...ACTIVE_STAGES].sort()).toEqual(["changes_requested", "discussing", "in_progress", "pr_opened", "review_passed", "spec_ready", "triaged"]);
    for (const resting of ["needs_human", "merged", "closed_unmerged", "closed"]) expect(ACTIVE_STAGES.has(resting)).toBe(false);
  });

  it("simulate no live events, then a stage change on the next read: the board updates by itself within 20 s", async () => {
    const { board, setPage } = await polling();
    expect(board.getState().items.get(ID).stage).toBe("in_progress");
    setPage(moved(PAGE, ID, "needs_human"));
    await tick(POLL_MS - 1);
    expect(board.getState().items.get(ID).stage).toBe("in_progress"); // not before the interval
    await tick(1);
    expect(board.getState().items.get(ID).stage).toBe("needs_human");
    board.destroy();
  });

  it("an answer that is the same as what is showing redraws nothing", async () => {
    const { board, get, changes } = await polling();
    const before = countReads(get);
    await tick(POLL_MS * 3);
    expect(countReads(get)).toBe(before + 3); // it did read
    expect(changes).toEqual([]); // and changed nothing, so onChange (the redraw) never ran
    board.destroy();
  });

  it("a change redraws once, and an item that left the list is dropped", async () => {
    const { board, changes, setPage } = await polling();
    setPage({ ...PAGE, data: PAGE.data.slice(1) });
    await tick(POLL_MS);
    expect(changes).toHaveLength(1);
    expect(board.getState().items.has(ID)).toBe(false);
    board.destroy();
  });

  it("reads nothing while no item is in an active stage, and starts again when one is", async () => {
    const resting = { ...PAGE, data: PAGE.data.map((i) => ({ ...i, stage: "merged" })) };
    const { board, get, setPage } = await polling();
    setPage(resting);
    await tick(POLL_MS); // reads once: the board still shows active items; now it shows only resting ones
    const after = countReads(get);
    await tick(POLL_MS * 3);
    expect(countReads(get)).toBe(after); // nothing active: no reads
    expect(board.getState().items.get(ID).stage).toBe("merged");
    board.destroy();
  });

  it("reads nothing while the page is hidden", async () => {
    let hidden = true;
    const { board, get } = await polling({ hidden: () => hidden });
    const before = countReads(get);
    await tick(POLL_MS * 2);
    expect(countReads(get)).toBe(before);
    hidden = false;
    await tick(POLL_MS);
    expect(countReads(get)).toBe(before + 1);
    board.destroy();
  });

  it("a failed read keeps the board that is showing, and the next one recovers", async () => {
    let bad = false;
    const get = fakeGet({ "/api/v1/work-items": () => (bad ? fail(500) : PAGE), "/api/v1/repos": REPOS });
    const board = createBoard({ get });
    board.connectLive(fakeLive());
    await board.load();
    bad = true;
    await tick(POLL_MS);
    expect(board.getState().status).toBe("ready");
    expect(board.getState().items.size).toBe(PAGE.data.length);
    bad = false;
    await tick(POLL_MS);
    expect(board.getState().status).toBe("ready");
    board.destroy();
  });

  it("stops when the board is destroyed", async () => {
    const { board, get } = await polling();
    board.destroy();
    const before = get.calls.length;
    await tick(POLL_MS * 5);
    expect(get.calls.length).toBe(before);
  });

  it("sameItems compares rows by value", () => {
    const a = new Map([["x", { id: "x", stage: "triaged" }]]);
    expect(sameItems(a, new Map([["x", { id: "x", stage: "triaged" }]]))).toBe(true);
    expect(sameItems(a, new Map([["x", { id: "x", stage: "merged" }]]))).toBe(false);
    expect(sameItems(a, new Map())).toBe(false);
  });
});
