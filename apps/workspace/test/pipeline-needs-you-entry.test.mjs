// apps/workspace/test/pipeline-needs-you-entry.test.mjs
//
// D#37 WS-F1d (C47 group D): the Pipeline board's "Needs you (N)" button. Its number comes from the Needs you model's own read and row rules, so the
// board and the Needs you heading cannot disagree; nothing of those rules is copied under apps/pipeline. The real board header, the click and the
// phone layout are driven in e2e/pipeline.spec.ts.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASKS_FIRST_URL, LIST_URL, MERGE_URL, ME_URL, NEEDS_HUMAN_URL, STALLED_URL, createNeedsYou, entryLabel, readNeedsYouCount } from "../apps/needs-you/needs-you-model.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..", "..", "packages");
const fixture = (op, name) => JSON.parse(readFileSync(join(PACKAGES, "api", "fixtures", "v1", op, name), "utf8"));
const ASK = fixture("listDecisionAsks", "200-ok.json").data[0];
const SETUP = fixture("listSetupRequests", "200-ok.json");
const MERGES = fixture("listMergeReady", "200-ok.json");
const STALLED = fixture("listStalledItems", "200-ok.json");

/** A fake call() over the six reads; `over` replaces any of them by "METHOD path". */
const fake = (over = {}) => {
  const routes = {
    ["GET " + LIST_URL]: SETUP,
    ["GET " + ASKS_FIRST_URL]: { data: [ASK], next_cursor: null },
    ["GET " + MERGE_URL]: MERGES,
    ["GET " + STALLED_URL]: { items: [{ ...STALLED.items[0], work_item_id: "11111111-1111-4111-8111-111111111111" }], not_shown: 0 },
    ["GET " + NEEDS_HUMAN_URL]: { data: [{ id: "22222222-2222-4222-8222-222222222222", title: "Needs a person", updated_at: "2026-10-20T00:00:00.000Z" }, { id: ASK.work_item_id, title: "Has an ask", updated_at: "2026-10-20T00:00:00.000Z" }], next_cursor: null },
    ["GET " + ME_URL]: { is_admin: true },
    ...over,
  };
  return async (method, path) => {
    const r = routes[method + " " + path];
    if (r === undefined) throw Object.assign(new Error("x"), { status: 404 });
    const v = typeof r === "function" ? r() : r;
    if (v instanceof Error) throw v;
    return v;
  };
};

describe("the board's Needs you count", () => {
  it("D2: for one mixed fixture set, the board number equals the Needs you heading number", async () => {
    const call = fake();
    const list = createNeedsYou({ call });
    await list.load();
    const heading = list.state.rows.filter((r) => r.state === "open").length;
    const board = await readNeedsYouCount(call);
    expect(board).toEqual({ count: heading, more: false });
    // ask, stalled, needs-a-person, merge, setup: the item that is both needs_human and has an ask is counted once
    expect(heading).toBe(list.state.rows.length);
    expect(list.state.rows.map((r) => r.kind)).toEqual(["ask", "person", "stalled", "merge", "setup"]); // stalled and needs-a-person together, oldest first
  });

  it("D1: the label is Needs you (N), (N+) at a page cap or when rows are not shown, Nothing needs you at 0, and bare while the count is unknown", async () => {
    expect(entryLabel({ count: 3, more: false })).toBe("Needs you (3)");
    expect(entryLabel({ count: 3, more: true })).toBe("Needs you (3+)");
    expect(entryLabel({ count: 0, more: false })).toBe("Nothing needs you");
    expect(entryLabel(null)).toBe("Needs you");
    expect(entryLabel(undefined)).toBe("Needs you");
    const shown = await readNeedsYouCount(fake({ ["GET " + MERGE_URL]: { items: [], not_shown: 4 } }));
    expect(shown.more).toBe(true);
    expect(shown.count).toBe((await readNeedsYouCount(fake({ ["GET " + MERGE_URL]: { items: [], not_shown: 0 } }))).count + 4);
    const capped = await readNeedsYouCount(fake({ ["GET " + NEEDS_HUMAN_URL]: () => ({ data: [], next_cursor: "more" }), ["GET " + NEEDS_HUMAN_URL + "&cursor=more"]: () => ({ data: [], next_cursor: "more" }) }));
    expect(capped.more).toBe(true);
    const empty = await readNeedsYouCount(fake({ ["GET " + LIST_URL]: { requests: [], truncated: false }, ["GET " + ASKS_FIRST_URL]: { data: [], next_cursor: null }, ["GET " + MERGE_URL]: { items: [], not_shown: 0 }, ["GET " + STALLED_URL]: { items: [], not_shown: 0 }, ["GET " + NEEDS_HUMAN_URL]: { data: [], next_cursor: null } }));
    expect(entryLabel(empty)).toBe("Nothing needs you");
  });

  it("D2: no Needs you URL or row rule is repeated under apps/pipeline", () => {
    const dir = join(HERE, "..", "apps", "pipeline");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/decision-asks|stalled-items|merge-ready|stage=needs_human|setup-requests/);
    }
  });
});
