// apps/workspace/test/memory-app.test.mjs
//
// D#601 MEM-4a3: the Memory app's data side and pure rules, against the memory routes' committed fixtures; and the BUILT output (the app built
// into a scratch directory, the shipped files read back). The DOM behaviour is in e2e/memory.spec.ts; the vitest environment here is node.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { build, shippedPath } from "../build/build.mjs";
import { ApiFailure } from "../apps/_lib/api.js";
import {
  COPY, STATUSES, STATUS_GLYPHS, batchButtonWords, batchesOf, byteLength, checkEdit, decideBatch, decideOne, editEntry, failureWords, loadCounts, loadList, loadQueue, loadRepos,
  loadRuns, openCard, runName, runsWords, scopesOfCards, statusView, text, waitingWords,
} from "../apps/memory/memory-storage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const V1 = join(HERE, "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = fx("listMemory", "200-ok.json");
const QUEUE = fx("getMemoryQueue", "200-ok.json");
const COUNTS = fx("getMemoryPendingCounts", "200-ok.json");
const RUNS = fx("listMemoryRuns", "200-ok.json");

/** A fake get(): logs every call; `reply(method, url, body)` returns the body or throws. */
function fakeGet(reply) {
  const calls = [];
  const get = async (method, url, body) => {
    calls.push(method + " " + url + (body === undefined ? "" : " " + JSON.stringify(body)));
    return structuredClone(reply(method, url, body));
  };
  get.calls = calls;
  return get;
}

describe("the one formatter: no null or undefined text in any state", () => {
  it("text() answers the fallback for null, undefined, NaN, blanks and the words themselves", () => {
    for (const v of [null, undefined, NaN, "", "   ", "null", "undefined", "NaN", {}, [], true]) expect(text(v, "x"), String(v)).toBe("x");
    expect(text("  kept  ")).toBe("kept");
    expect(text(0)).toBe("0");
  });

  it("statusView() has a case for each of the eight statuses, text plus an icon, and none reads null or undefined", () => {
    for (const [status, label] of STATUSES) {
      const v = statusView(status, undefined, undefined);
      expect(v.label, status).toBe(label);
      expect(Object.values(STATUS_GLYPHS)).toContain(v.glyph);
      expect(JSON.stringify(v)).not.toMatch(/null|undefined/);
    }
    // The server's words win when it sent them; a status nobody knows still reads as words.
    expect(statusView("approved", "Approved", "check")).toEqual({ label: "Approved", glyph: "✓", status: "approved" });
    expect(statusView("bogus", null, null)).toMatchObject({ label: "Unknown status", glyph: "?" });
    expect(statusView(undefined, undefined, undefined).label).toBe("Unknown status");
  });

  it("every state of the screens draws no null or undefined from the fixtures: list rows, queue cards, counts, runs", () => {
    const rows = LIST.groups.flatMap((g) => g.entries);
    for (const r of rows) {
      const parts = [statusView(r.status, r.status_label, r.status_icon).label, text(r.kind_label), text(r.title), text(r.source), text(r.age), runsWords(r).label];
      for (const p of parts) expect(p).not.toMatch(/null|undefined|NaN/);
    }
    for (const c of QUEUE.cards) for (const p of [text(c.title), text(c.proposed_by), text(c.scope_label), text(c.source), text(c.age), text(c.evidence)]) expect(p).not.toMatch(/null|undefined|NaN/);
    expect(waitingWords(undefined)).toBe(COPY.countUnavailable);
    expect(waitingWords(null)).toBe(COPY.countUnavailable);
    expect(waitingWords(0)).toBe("0 waiting");
    expect(runName("8b2c5e74-1f3a-4d96-a0b7-6c4e2d1f9a38")).toBe("Run 8b2c5e74");
  });
});

describe("Used in N runs", () => {
  it("shows the number: 0 when none, singular for one", () => {
    expect(runsWords({ runs: 0 })).toEqual({ n: 0, label: "Used in 0 runs" });
    expect(runsWords({ runs: 1 }).label).toBe("Used in 1 run");
    expect(runsWords({ runs: 2 }).label).toBe("Used in 2 runs");
    expect(runsWords({}).n).toBe(0);
    expect(runsWords(null).n).toBe(0);
  });
});

describe("the queue rules", () => {
  const card = (id, kind, source, open) => ({ entry: { id, author_kind: kind, scope: "repo" }, source, open_state: open, scope_label: "acme/widgets" });

  it("batches by source only, counts the unopened gated cards, and writes the words the Spec gives", () => {
    const cards = [card("1", "import", "Imported from CLAUDE.md", "unopened"), card("2", "import", "Imported from CLAUDE.md", "unopened"), card("3", "import", "Imported from CLAUDE.md", "opened"), card("4", "agent", "Proposed by an agent", "not_required"), card("5", "agent", "Proposed by an agent", "not_required")];
    const [imp, agent] = batchesOf(cards);
    expect(imp).toMatchObject({ source: "Imported from CLAUDE.md", size: 3, gated: true, unopened: 2 });
    expect(agent).toMatchObject({ source: "Proposed by an agent", size: 2, gated: false, unopened: 0 });
    expect(batchButtonWords(imp, "Approve")).toBe("Open each card first (2 left)");
    expect(batchButtonWords(agent, "Approve")).toBe("Approve all 2");
    expect(batchesOf(cards.slice(0, 3).map((c) => ({ ...c, open_state: "opened" })))[0]).toMatchObject({ unopened: 0 });
    expect(batchButtonWords({ ...imp, unopened: 0 }, "Reject")).toBe("Reject all 3");
  });

  it("two sources are two batches, never one; a runner source is not an import source", () => {
    const b = batchesOf([card("1", "import", "Imported from CLAUDE.md", "opened"), card("2", "import", "Imported from AGENTS.md", "opened"), card("3", "runner_agent", "Imported from CLAUDE.md", "opened")]);
    expect(b.map((x) => x.key)).toEqual(["import|Imported from CLAUDE.md", "import|Imported from AGENTS.md", "runner_agent|Imported from CLAUDE.md"]);
  });

  it("a batch over 20 cannot be pressed", () => {
    const big = batchesOf(Array.from({ length: 21 }, (_, i) => card(String(i), "agent", "s", "not_required")))[0];
    expect(batchButtonWords(big, "Approve")).toBe("Too many to decide at once");
  });

  it("groups the cards by scope label with the scope", () => {
    const s = scopesOfCards(QUEUE.cards);
    expect(s.map((x) => [x.scope, x.label])).toEqual([["repo", "acme/widgets"], ["item", "#42 Add the thing"]]);
  });
});

describe("the sentence for a refusal", () => {
  it("shows the server's fixed sentence for must_open_first, mixed_sources and conflict, and nothing else it wrote", () => {
    const fixture = fx("decideMemoryBatch", "422-must_open_first.json").error;
    expect(failureWords(new ApiFailure(422, fixture.code, fixture.message, []))).toBe("2 of these cards have not been opened yet; open each one first");
    expect(failureWords(new ApiFailure(422, "mixed_sources", "a batch can only hold cards from one source"))).toBe("a batch can only hold cards from one source");
    expect(failureWords(new ApiFailure(409, "conflict", "that entry was changed by someone else; reload and try again"))).toMatch(/changed by someone else/);
    expect(failureWords(new ApiFailure(422, "secret_detected", "request failed validation"))).toBe(COPY.secret);
    expect(failureWords(new ApiFailure(403, "forbidden", "server text that must never be shown"))).toBe(COPY.forbidden);
    expect(failureWords(new ApiFailure(404, "not_found", "server text that must never be shown"))).toBe(COPY.gone);
    expect(failureWords(new ApiFailure(422, "invalid_message", "server text that must never be shown"))).toBe(COPY.failed);
    expect(failureWords(new ApiFailure(500, "x", "Something went wrong on our side. Try again in a moment."))).toMatch(/our side/);
    expect(failureWords(new ApiFailure(429, "rate_limited", "x", undefined, 8))).toBe("Try again in 8 seconds.");
    expect(failureWords(undefined)).toBe(COPY.failed);
  });

  it("checkEdit() names the limits in bytes (multi-byte text counts as bytes)", () => {
    expect(checkEdit("", "")).toBe("Write the memory first.");
    expect(checkEdit("ok", "")).toBe("");
    expect(checkEdit("x".repeat(1024), "")).toBe("");
    expect(checkEdit("x".repeat(1025), "")).toMatch(/at most 1024 bytes\. This one is 1025/);
    expect(byteLength("é".repeat(513))).toBe(1026);
    expect(checkEdit("é".repeat(513), "")).toMatch(/1026/);
    expect(checkEdit("ok", "w".repeat(257))).toMatch(/at most 256/);
  });
});

describe("the calls", () => {
  const reply = (method, url) => {
    if (url.startsWith("/api/v1/memory/queue")) return QUEUE;
    if (url.startsWith("/api/v1/memory/pending-counts")) return COUNTS;
    if (url.endsWith("/runs")) return RUNS;
    if (url.startsWith("/api/v1/memory")) return LIST;
    if (url.startsWith("/api/v1/repos")) return fx("listRepos", "200-page.json");
    return {};
  };

  it("reads the list with its filters, the queue, the repos, the counts and an entry's runs", async () => {
    const get = fakeGet(reply);
    const list = await loadList({ kinds: ["fact"], statuses: ["proposed", "approved"] }, get);
    expect(get.calls[0]).toBe("GET /api/v1/memory?kind=fact&status=proposed,approved");
    expect(list.groups.map((g) => g.scope)).toEqual(["repo", "account"]);
    expect(list.groups[0].targetId).toBe("5b1f0c7e-2d6a-4a53-9a39-1c2f3a4b5c6d");
    expect((await loadQueue(get)).cards).toHaveLength(2);
    expect((await loadRepos(get)).map((r) => r.name)).toEqual(["acme/widgets"]); // a repo with no name is left out
    const ids = Object.keys(COUNTS.repos);
    expect(await loadCounts(ids, Object.keys(COUNTS.items), get)).toEqual(COUNTS);
    expect(get.calls.at(-1)).toContain("/api/v1/memory/pending-counts?repo_ids=" + ids[0] + "&item_ids=" + Object.keys(COUNTS.items)[0]);
    const runs = await loadRuns("1a8b2e3f-4c5d-4e6f-9071-82930415b6c7", get);
    expect(runs.total).toBe(2);
    expect(runs.runs.map((r) => r.id)).toEqual(RUNS.runs.map((r) => r.id));
  });

  it("a counts failure is null (the badge says it is unavailable), a repos failure is an empty list; a bad id is never sent", async () => {
    const failing = fakeGet(() => {
      throw new ApiFailure(500, "server_error", "x");
    });
    expect(await loadCounts(["33333333-3333-4333-8333-333333333333"], [], failing)).toBeNull();
    expect(await loadRepos(failing)).toEqual([]);
    const none = fakeGet(reply);
    expect(await loadCounts(["not-a-uuid"], [], none)).toEqual({ repos: {}, items: {} });
    expect(none.calls).toEqual([]);
  });

  it("writes: open, decide, decide a batch, edit (a blank reason is null, the kind is optional)", async () => {
    const get = fakeGet(() => ({}));
    await openCard("a", get);
    await decideOne("a", "rejected", get);
    await decideBatch(["a", "b"], "approved", get);
    await editEntry("a", { body: "  new text ", why: " ", kind: "gotcha" }, get);
    await editEntry("a", { body: "t", why: "because" }, get);
    expect(get.calls).toEqual([
      "POST /api/v1/memory/a/open",
      'POST /api/v1/memory/a/decide {"to":"rejected"}',
      'POST /api/v1/memory/decide-batch {"ids":["a","b"],"to":"approved"}',
      'POST /api/v1/memory/a/edit {"body":"new text","why":null,"kind":"gotcha"}',
      'POST /api/v1/memory/a/edit {"body":"t","why":"because"}',
    ]);
  });

  it("an empty or malformed answer reads as empty, never as a crash", async () => {
    expect(await loadList({}, fakeGet(() => null))).toEqual({ groups: [], truncated: false });
    expect(await loadQueue(fakeGet(() => ({ cards: [{}, null, { entry: { id: "x" } }] })))).toEqual({ cards: [], truncated: false });
    expect(await loadRuns("a", fakeGet(() => ({})))).toEqual({ total: 0, runs: [], truncated: false });
  });
});

describe("the built output: the app shipped from a scratch build, read back", () => {
  const dirs = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const result = (() => {
    const scratch = mkdtempSync(join(tmpdir(), "m4a-memory-build-"));
    dirs.push(scratch);
    mkdirSync(scratch, { recursive: true });
    return build({ profilePath: join(HERE, "..", "profiles", "cloud.json"), shellDir: join(HERE, "..", "shell"), outDir: join(scratch, "dist") });
  })();
  const shipped = (rel) => readFileSync(shippedPath(result, rel), "utf8");

  it("ships the app's files, the tag in index.html, and no more than the per-app boot ceiling", () => {
    const files = result.copiedFiles.filter((f) => f.startsWith("apps/memory/")).sort();
    expect(files).toEqual(["apps/memory/memory-app.css", "apps/memory/memory-app.js", "apps/memory/memory-storage.js"]);
    expect(result.bootFiles.filter((f) => f.startsWith("apps/memory/")).length).toBeLessThanOrEqual(5);
    expect(shipped("index.html")).toContain('data-app="memory"');
  });

  it("the shipped code carries the Spec's words, uses no markup sink, and every import resolves to a shipped file", () => {
    const all = ["memory-app.js", "memory-storage.js"].map((f) => shipped("apps/memory/" + f)).join("\n");
    for (const w of ["Open each card first (", "Edit then approve", "Used in ", "Approve", "Reject"]) expect(all, w).toContain(w);
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "eval(", "document.write"]) expect(all, sink).not.toContain(sink);
    for (const rel of ["memory-app.js", "memory-storage.js"]) {
      const code = shipped("apps/memory/" + rel);
      for (const m of code.matchAll(/from\s*"(\.[^"]+)"/g)) {
        const target = join("apps/memory", m[1]).replace(/\\/g, "/");
        expect(() => readFileSync(shippedPath(result, target)), m[1]).not.toThrow();
      }
    }
    expect(readdirSync(dirname(shippedPath(result, "apps/memory/memory-app.js")))).toContain("memory-app.css");
  });
});
