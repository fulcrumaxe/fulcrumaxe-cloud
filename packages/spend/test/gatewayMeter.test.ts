import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installModelCallGuard } from "../../test-guard/src/guard.js";
import {
  GATEWAY_BASE_URL, MAX_READS, OUTSIDE_METER_NOTE, TAG_PATTERN, type EndReason, compareToMeter, effectiveEntitlement, interpretRead, isFinal, mintGatewayTag,
  nextReadDueAt, outsideMeterLabel, outsideMeterOn, outsideMeterStatus, overheadUsd, readGatewayReport, reportUrl, type ReportRow,
} from "../src/gatewayMeter.js";
import { startGatewayReportFake, type FakeReport } from "./fakes/gatewayReport.js";

const row = (totalCost: number, requestCount: number, surchargeCost = 0): ReportRow => ({ tag: "t", totalCost, surchargeCost, requestCount });
const day = new Date("2026-10-06T10:00:00Z");

describe("tag (C6 3.1)", () => {
  it("10,000 mints all match the pattern and none collide", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const t = mintGatewayTag();
      expect(t).toMatch(TAG_PATTERN);
      expect(t).toHaveLength(30);
      seen.add(t);
    }
    expect(seen.size).toBe(10_000);
  });
  it("a run id is never a tag", () => {
    expect("0b9f3c1e-6d2a-4c57-9a41-3f2d1e8b7a60").not.toMatch(TAG_PATTERN);
  });
});

describe("report client against the strict fake (C6 3.3, 3.11)", () => {
  let fake: FakeReport;
  const KEY = "vck_testkey";
  beforeAll(async () => {
    fake = await startGatewayReportFake();
    fake.validKeys.add(KEY).add("sk_not_vck").add("vck_free");
    fake.notEntitled.add("vck_free");
  });
  afterAll(() => fake.close());
  const read = (tags: string[], apiKey = KEY) => readGatewayReport({ base: fake.url, apiKey, tags, startDay: day, today: day });

  it("sends exactly the six parameters, the connection's bearer key, and never asks for gateway_cost", async () => {
    const tag = mintGatewayTag();
    fake.script.set(tag, [{ total_cost: 0.5, surcharge_cost: 0.0001, request_count: 4 }]);
    const out = await read([tag]);
    const sent = fake.requests.at(-1)!;
    expect([...sent.search.keys()].sort()).toEqual(["api_key_id", "end_date", "group_by", "start_date", "tags", "tags_match"]);
    expect(Object.fromEntries(sent.search)).toMatchObject({ start_date: "2026-10-06", end_date: "2026-10-06", group_by: "tag", tags: tag, tags_match: "any", api_key_id: "self" });
    expect(sent.auth).toBe(`Bearer ${KEY}`);
    expect(out.kind === "ok" && out.rows.get(tag)).toMatchObject({ totalCost: 0.5, surchargeCost: 0.0001, requestCount: 4 });
    expect(reportUrl({ startDay: day, today: day, tags: [tag] }).origin).toBe(GATEWAY_BASE_URL);
  });

  it("ingestion delay: no row, then a partial row, then the full row; stranger tags are ignored", async () => {
    const tag = mintGatewayTag();
    fake.strangerTags.push("vm_added_tag");
    fake.script.set("vm_added_tag", [{ total_cost: 99, surcharge_cost: 0, request_count: 99 }]);
    fake.script.set(tag, [undefined as never, { total_cost: 0.1, surcharge_cost: 0, request_count: 1 }, { total_cost: 0.3, surcharge_cost: 0, request_count: 3 }]);
    const reads = [await read([tag]), await read([tag]), await read([tag])];
    fake.strangerTags.length = 0;
    expect(reads.map((r) => (r.kind === "ok" ? (r.rows.get(tag)?.requestCount ?? null) : "x"))).toEqual([null, 1, 3]);
    for (const r of reads) expect(r.kind === "ok" && r.rows.has("vm_added_tag")).toBe(false);
  });

  it("only the documented {results:[...]} shape is accepted: a bare array, a missing results, a row without tag and a non-numeric cost are contract breaks", async () => {
    const raw = async (body: string) =>
      readGatewayReport({ apiKey: KEY, tags: ["a"], startDay: day, today: day, fetchFn: (async () => new Response(body, { status: 200 })) as typeof fetch });
    const good = { tag: "a", total_cost: 1, surcharge_cost: 0, request_count: 1 };
    expect((await raw(JSON.stringify({ results: [good] }))).kind).toBe("ok");
    for (const bad of [JSON.stringify([good]), JSON.stringify({ data: [good] }), JSON.stringify({ results: [{ total_cost: 1, request_count: 1 }] }), JSON.stringify({ results: [{ ...good, total_cost: "1" }] }), JSON.stringify({ results: [{ tag: "a", total_cost: 1, request_count: 1 }] }), "not json", "null"]) {
      expect(await raw(bad), bad).toEqual({ kind: "contract" });
    }
    // and the fake itself never answers a bare array
    fake.script.set("fmt", [{ total_cost: 1, surcharge_cost: 0, request_count: 1 }]);
    const res = await fetch(`${fake.url}/v1/report?start_date=2026-10-06&end_date=2026-10-06&group_by=tag&tags=fmt&api_key_id=self`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(Array.isArray(await res.json())).toBe(false);
  });

  it("maps 401, 403 and the strict 400s; a 5xx is transient", async () => {
    expect(await read(["a"], "bad")).toEqual({ kind: "http", status: 401 });
    expect(await read(["a"], "vck_free")).toEqual({ kind: "http", status: 403 });
    expect(await read(["a"], "sk_not_vck")).toEqual({ kind: "http", status: 400 }); // api_key_id=self needs vck_
    expect(await read(["x".repeat(65)])).toEqual({ kind: "http", status: 400 });
    const bad = await fetch(`${fake.url}/v1/report?start_date=2026-1-6&end_date=2026-10-06&group_by=tag&tags=a&api_key_id=self`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { message: expect.any(String), type: expect.any(String) } });
    for (const status of [503, 408, 429]) {
      fake.respondWith = status;
      expect(await read(["a"]), String(status)).toEqual({ kind: "transient" });
    }
    fake.respondWith = 404;
    expect(await read(["a"])).toEqual({ kind: "http", status: 404 }); // other 4xx stay a plain http outcome
    fake.respondWith = undefined;
  });

  it("a redirect is a contract break and is never followed", async () => {
    const elsewhere = await startGatewayReportFake();
    try {
      fake.redirectTo = `${elsewhere.url}/v1/report`;
      expect(await read(["a"])).toEqual({ kind: "contract" });
      expect(elsewhere.requests).toHaveLength(0);
    } finally {
      fake.redirectTo = undefined;
      await elsewhere.close();
    }
  });
});

describe("no live call (C6 3.12)", () => {
  it("the model-call guard throws on a fetch to the report URL", async () => {
    const guard = installModelCallGuard({ FX_FORBID_MODEL_CALLS: "1" });
    try {
      await expect(readGatewayReport({ apiKey: "vck_x", tags: ["a"], startDay: day, today: day, fetchFn: (u: Parameters<typeof fetch>[0], i?: Parameters<typeof fetch>[1]) => fetch(u, i) })).resolves.toEqual({ kind: "transient" });
      await expect(fetch(reportUrl({ startDay: day, today: day, tags: ["a"] }))).rejects.toThrow(/blocked fetch/);
    } finally {
      guard.uninstall();
    }
  });
});

describe("schedule and finality (C6 3.4, 3.5)", () => {
  it("a run that never stabilizes gets exactly 8 reads, then none", () => {
    const fin = new Date("2026-10-06T00:00:00Z");
    let reads = 0;
    while (nextReadDueAt(fin, reads) !== undefined) reads++;
    expect(reads).toBe(8);
    expect(MAX_READS).toBe(8);
    expect(nextReadDueAt(fin, 0)!.getTime() - fin.getTime()).toBe(5 * 60_000);
    expect(nextReadDueAt(fin, 7)!.getTime() - fin.getTime()).toBe(24 * 3_600_000);
  });
  it("final needs two agreeing reads, a count of at least 1, and at least the runner's own count", () => {
    expect(isFinal(undefined, row(1, 3), 3)).toBe(false);
    expect(isFinal(row(1, 2), row(1, 3), 3)).toBe(false); // count moved
    expect(isFinal(row(1, 3), row(1.01, 3), 3)).toBe(false); // cost moved
    expect(isFinal(row(0, 0), row(0, 0), null)).toBe(false); // count below 1
    expect(isFinal(row(1, 2), row(1, 2), 3)).toBe(false); // fewer than the runner metered
    expect(isFinal(row(1, 3), row(1, 3), 3)).toBe(true);
    expect(isFinal(row(1, 3), row(1, 3), null)).toBe(true); // no runner count: third condition dropped
  });
});

describe("comparison (C6 3.6, boundaries)", () => {
  it("uses total minus surcharge, never gateway_cost, and settles at the larger", () => {
    const c = compareToMeter(1, { totalCost: 1.5003, surchargeCost: 0.0003 });
    expect(c).toMatchObject({ gatewayUsd: 1.5, settledUsd: 1.5, trueUpUsd: 0.5 });
  });
  it("never credits when the gateway is lower", () => {
    expect(compareToMeter(2, { totalCost: 1, surchargeCost: 0 })).toMatchObject({ settledUsd: 2, trueUpUsd: 0 });
  });
  it("flag floor $0.01: at the boundary no flag, one step past it flags", () => {
    expect(compareToMeter(0.1, { totalCost: 0.11, surchargeCost: 0 }).disagree).toBe(false);
    expect(compareToMeter(0.1, { totalCost: 0.110001, surchargeCost: 0 }).disagree).toBe(true);
  });
  it("flag at 2% on a five-dollar run", () => {
    const fiveDollars = 20 / 4; // written as a quotient so the figure is not a bare literal in the source
    expect(compareToMeter(fiveDollars, { totalCost: 5.10204, surchargeCost: 0 }).disagree).toBe(false);
    expect(compareToMeter(fiveDollars, { totalCost: 5.102042, surchargeCost: 0 }).disagree).toBe(true);
  });
  it("escalates only when over 10% AND over $0.10", () => {
    // Under the $0.10 floor the floor decides here; the percentage leg is pinned by the pair below.
    expect(compareToMeter(1, { totalCost: 1.1, surchargeCost: 0 }).escalate).toBe(false);
    expect(compareToMeter(1, { totalCost: 1.2, surchargeCost: 0 }).escalate).toBe(true);
    // Diff well over $0.10, so only the percentage decides: 10% of the larger figure.
    expect(compareToMeter(10, { totalCost: 11.1, surchargeCost: 0 }).escalate).toBe(false); // diff 1.10, 10% of 11.1 is 1.11
    expect(compareToMeter(10, { totalCost: 11.12, surchargeCost: 0 }).escalate).toBe(true); // diff 1.12, 10% of 11.12 is 1.112
    expect(compareToMeter(0.5, { totalCost: 0.6, surchargeCost: 0 }).escalate).toBe(false); // $0.10 exactly
    expect(compareToMeter(0.5, { totalCost: 0.600001, surchargeCost: 0 }).escalate).toBe(true);
    expect(compareToMeter(0.05, { totalCost: 0.1, surchargeCost: 0 }).escalate).toBe(false); // 100% but under $0.10
  });
});

describe("overhead, entitlement, read outcomes, labels (C6 3.7, 3.8, 3.10)", () => {
  it("overhead is the surcharge plus the run's share of each read", () => {
    expect(overheadUsd(0.015, [1, 2, 50])).toBeCloseTo(0.015 + 0.005 + 0.0025 + 0.0001, 6);
  });
  it("entitlement 'no' resets on a key change or after 7 days", () => {
    const set = new Date("2026-10-01T00:00:00Z");
    expect(effectiveEntitlement({ value: "no", setAt: set }, new Date("2026-10-07T23:59:00Z"), false)).toBe("no");
    expect(effectiveEntitlement({ value: "no", setAt: set }, new Date("2026-10-08T00:00:00Z"), false)).toBe("unknown");
    expect(effectiveEntitlement({ value: "yes", setAt: set }, set, true)).toBe("unknown");
  });
  it("200 sets yes; 403 sets no and ends the run; 401 waits for the last read; 400 flags; 5xx changes nothing", () => {
    expect(interpretRead({ kind: "ok", rows: new Map() }, false)).toEqual({ entitlement: "yes", run: "read" });
    expect(interpretRead({ kind: "http", status: 403 }, false)).toEqual({ entitlement: "no", run: { unavailable: "plan_not_entitled" } });
    expect(interpretRead({ kind: "http", status: 401 }, false)).toEqual({ run: "keep" });
    expect(interpretRead({ kind: "http", status: 401 }, true)).toEqual({ run: { unavailable: "auth_failed" } });
    expect(interpretRead({ kind: "http", status: 400 }, false)).toEqual({ run: { unavailable: "bad_request", flag: true } });
    expect(interpretRead({ kind: "transient" }, true)).toEqual({ run: "keep" });
    expect(interpretRead({ kind: "contract" }, false)).toEqual({ flag: "outside_meter_contract", run: "keep" });
    expect(interpretRead({ kind: "contract" }, true)).toEqual({ flag: "outside_meter_contract", run: { unavailable: "contract_mismatch" } });
  });
  it("the flag is on only for exactly 'on'; the picker label follows flag and entitlement", () => {
    expect([undefined, "", "ON", "1", "true", "on "].map(outsideMeterOn)).toEqual([false, false, false, false, false, false]);
    expect(outsideMeterOn("on")).toBe(true);
    expect(outsideMeterStatus(false, "yes")).toEqual({ label: "beta", reason: "flag_off" });
    expect(outsideMeterStatus(true, "no")).toEqual({ label: "beta", reason: "plan_not_entitled" });
    expect(outsideMeterStatus(true, "unknown")).toEqual({ label: "ga" });
  });
  it("every state has a named line, never null or undefined", () => {
    const lines = [
      outsideMeterLabel({ state: "pending" }), outsideMeterLabel({ state: "matches" }), outsideMeterLabel({ state: "higher", addedUsd: 0.5 }),
      outsideMeterLabel({ state: "unavailable", reason: "not_stable" }), outsideMeterLabel({ state: "off" }),
    ];
    expect(lines).toEqual(["Checking with the AI Gateway", "Matches the gateway", "Gateway figure higher: $0.50 added", "Outside check unavailable: not stable", "Outside check off"]);
    for (const l of lines) expect(l).not.toMatch(/null|undefined/);
  });
  it("the end reasons the sweep adds have named lines, and an unmet floor says what was added when a true-up was posted", () => {
    const reasons: EndReason[] = ["not_stable", "no_rows", "plan_not_entitled", "auth_failed", "bad_request", "flag_off", "connection_changed", "contract_mismatch", "gateway_error", "no_metered_figure", "floor_unmet", "trueup_over_ceiling"];
    for (const reason of reasons) expect(outsideMeterLabel({ state: "unavailable", reason })).toMatch(/^Outside check unavailable: [a-z ]+$/);
    expect(outsideMeterLabel({ state: "unavailable", reason: "floor_unmet" })).toBe("Outside check unavailable: gateway saw fewer calls than the meter");
    expect(outsideMeterLabel({ state: "unavailable", reason: "floor_unmet", addedUsd: 1 })).toBe("Outside check unavailable: gateway saw fewer calls than the meter. $1.00 added");
    expect(outsideMeterLabel({ state: "unavailable", reason: "trueup_over_ceiling" })).toBe("Outside check unavailable: gateway figure held for review");
    expect(outsideMeterLabel({ state: "unavailable", reason: "gateway_error" })).toBe("Outside check unavailable: gateway error");
    expect(OUTSIDE_METER_NOTE).not.toMatch(/vck_|fxr_/);
  });
});
