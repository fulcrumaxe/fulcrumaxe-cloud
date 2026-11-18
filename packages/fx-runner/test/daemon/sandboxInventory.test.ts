import { describe, expect, it } from "vitest";
import { ClaimMessage, SANDBOX_INVENTORY_MAX_QUIET_SECONDS, SANDBOX_INVENTORY_MIN_PROTOCOL, type SandboxInventoryRow } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { createInventoryReporter, emptyInventorySource, inventoryFingerprint, type InventorySource } from "../../src/daemon/sandboxInventory.js";
import { generateRunnerKey } from "../../src/keys.js";

const row = (name: string, over: Partial<SandboxInventoryRow> = {}): SandboxInventoryRow => ({ name, state: "stopped", created_at: "2026-11-01T10:00:00Z", last_used_at: null, disk_bytes: 1, snapshot_count: 0, snapshot_age_s: null, ...over });
const T0 = Date.UTC(2026, 10, 18, 12);
const QUIET = SANDBOX_INVENTORY_MAX_QUIET_SECONDS * 1000;

function reporter(rows: () => readonly SandboxInventoryRow[]) {
  let now = T0;
  const source: InventorySource = { list: async () => rows() };
  const r = createInventoryReporter({ source, now: () => new Date(now) });
  return { r, at: (ms: number) => void (now = T0 + ms) };
}

/** D#587 B-7a: the runner sends the block when its hash changed, or at least every ten minutes, and counts a send only once the cloud answered 200. */
describe("inventory reporter send rule", () => {
  it("the quiet limit is ten minutes and the default source lists nothing", async () => {
    expect(SANDBOX_INVENTORY_MAX_QUIET_SECONDS).toBe(600);
    expect(await emptyInventorySource.list()).toEqual([]);
  });

  it("sends the first list, then nothing while the hash is the same and under ten minutes have passed", async () => {
    const { r, at } = reporter(() => [row("a")]);
    const first = await r.next();
    expect(first?.rows).toEqual([row("a")]);
    first!.commit();
    for (const ms of [1, 30_000, QUIET - 1]) {
      at(ms);
      expect(await r.next(), `${ms} ms`).toBeUndefined();
    }
  });

  it("sends again at exactly ten minutes with the same list", async () => {
    const { r, at } = reporter(() => [row("a")]);
    (await r.next())!.commit();
    at(QUIET);
    const again = await r.next();
    expect(again?.rows).toEqual([row("a")]);
    again!.commit();
    at(QUIET + 1);
    expect(await r.next()).toBeUndefined();
    at(2 * QUIET);
    expect(await r.next()).toBeDefined();
  });

  it("sends at once when any field of any row changes, and when a row is added or removed", async () => {
    let list = [row("a"), row("b")];
    const { r, at } = reporter(() => list);
    (await r.next())!.commit();
    const changes: Array<() => SandboxInventoryRow[]> = [
      () => [row("a"), row("b", { state: "running" })],
      () => [row("a"), row("b", { disk_bytes: 2 })],
      () => [row("a"), row("b", { snapshot_count: 1 })],
      () => [row("a")],
      () => [row("a"), row("c")],
    ];
    let ms = 0;
    for (const change of changes) {
      list = change();
      at((ms += 1000));
      const next = await r.next();
      expect(next, JSON.stringify(list)).toBeDefined();
      next!.commit();
    }
  });

  it("does not resend when the source lists the same rows in another order", async () => {
    let list = [row("a"), row("b")];
    const { r, at } = reporter(() => list);
    (await r.next())!.commit();
    list = [row("b"), row("a")];
    at(1000);
    expect(await r.next()).toBeUndefined();
    expect(inventoryFingerprint([row("a"), row("b")])).toBe(inventoryFingerprint([row("b"), row("a")]));
  });

  it("an empty list is sent once, then every ten minutes, like any other", async () => {
    const { r, at } = reporter(() => []);
    const first = await r.next();
    expect(first?.rows).toEqual([]);
    first!.commit();
    at(1000);
    expect(await r.next()).toBeUndefined();
    at(QUIET);
    expect(await r.next()).toBeDefined();
  });

  it("a send that was never committed (the claim failed) is offered again", async () => {
    const { r, at } = reporter(() => [row("a")]);
    expect(await r.next()).toBeDefined();
    at(1000);
    expect(await r.next()).toBeDefined();
  });

  it("sends nothing when the source throws or lists what the schema refuses (201 rows, a bad name)", async () => {
    const boom = createInventoryReporter({ source: { list: async () => Promise.reject(new Error("helper down")) }, now: () => new Date(T0) });
    expect(await boom.next()).toBeUndefined();
    const many = reporter(() => Array.from({ length: 201 }, (_v, i) => row(`s${i}`)));
    expect(await many.r.next()).toBeUndefined();
    const bad = reporter(() => [row("Bad Name")]);
    expect(await bad.r.next()).toBeUndefined();
  });
});

describe("the claim carries the inventory", () => {
  function claimWith(opts: { rows?: readonly SandboxInventoryRow[]; protocolVersion?: number; status?: number }) {
    const seen: unknown[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(opts.status === 429 ? { retry_after: 4 } : { retry_after: 60 }), { status: opts.status ?? 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const sandboxInventory = createInventoryReporter({ source: { list: async () => opts.rows ?? [] }, now: () => new Date(T0) });
    const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(T0), fetchFn, sandboxInventory, ...(opts.protocolVersion === undefined ? {} : { protocolVersion: opts.protocolVersion }) });
    return { client, seen };
  }

  it("an ordinary claim carries the block once, then leaves it off while nothing changed", async () => {
    const { client, seen } = claimWith({ rows: [row("a")] });
    await client.claim();
    await client.claim();
    expect(seen).toEqual([{ sandboxes: [row("a")] }, {}]);
    expect(ClaimMessage.safeParse(seen[0]).success).toBe(true);
  });

  it("a claim the cloud did not accept (429) does not count as sent", async () => {
    const { client, seen } = claimWith({ rows: [row("a")], status: 429 });
    await client.claim();
    await client.claim();
    expect(seen).toEqual([{ sandboxes: [row("a")] }, { sandboxes: [row("a")] }]);
  });

  it("a status poll neither sends the block nor uses up its send: the next ordinary claim still carries it", async () => {
    const { client, seen } = claimWith({ rows: [row("a")] });
    await client.claim("bwrap_missing");
    await client.claim();
    expect(seen).toEqual([{ sandbox_unavailable: "bwrap_missing" }, { sandboxes: [row("a")] }]);
  });

  it("a status poll and a runner that declared an older protocol send no block", async () => {
    const poll = claimWith({ rows: [row("a")] });
    await poll.client.claim("bwrap_missing");
    expect(poll.seen).toEqual([{ sandbox_unavailable: "bwrap_missing" }]);
    const old = claimWith({ rows: [row("a")], protocolVersion: SANDBOX_INVENTORY_MIN_PROTOCOL - 1 });
    await old.client.claim();
    expect(old.seen).toEqual([{}]);
  });
});

describe("the reporter refuses impossible dates, so the cloud never has to", () => {
  it("sends nothing for a list holding 2026-02-30, month 13 or 25:61:61", async () => {
    for (const created_at of ["2026-02-30T00:00:00Z", "2026-13-45T10:00:00Z", "2026-01-01T25:61:61Z"]) {
      const r = createInventoryReporter({ source: { list: async () => [row("a", { created_at })] }, now: () => new Date(T0) });
      expect(await r.next(), created_at).toBeUndefined();
    }
  });
});
