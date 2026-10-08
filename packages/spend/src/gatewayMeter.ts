import { randomBytes } from "node:crypto";

/**
 * D#221 OM-2: the outside meter. A run on an `ai_gateway` connection carries an unguessable tag that the sandbox
 * firewall adds to every model request, outside the VM. After the run, the AI Gateway's own report for that tag is
 * read back and compared with what the runner metered. This file holds the pure parts: the tag, the report request
 * and its parsing, the read schedule, the finality rule, the comparison and the labels. No clock, no database.
 */

export const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";

/** Custom Reporting prices; source: Vercel AI Gateway Custom Reporting docs page, fetched 2026-10-06. */
export const GATEWAY_PRICES = {
  sourceUrl: "https://vercel.com/docs/ai-gateway/observability-and-spend/custom-reporting",
  fetched: "2026-10-06",
  tagWriteUsdPerRequest: 0.075 / 1000,
  reportQueryUsd: 0.005,
} as const;

export const TAG_PATTERN = /^fxr_[a-z2-7]{26}$/;
export const MAX_TAGS_PER_QUERY = 50;
/** A run is read at these delays after finalize (minutes: 5, 15, 35, 75, 180, 360, 720, 1440). */
export const READ_DELAYS_MS: readonly number[] = [5, 15, 35, 75, 180, 360, 720, 1440].map((m) => m * 60_000);
export const MAX_READS = READ_DELAYS_MS.length;
export const ENTITLEMENT_NO_TTL_MS = 7 * 24 * 3_600_000;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** `fxr_` + 26 base32 characters from 128 random bits, no padding. */
export function mintGatewayTag(random: (n: number) => Uint8Array = randomBytes): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of random(16)) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return `fxr_${out}`;
}

export const isGatewayTag = (value: unknown): value is string => typeof value === "string" && TAG_PATTERN.test(value);

/** `on` only when the value is exactly `on`; anything else, missing included, is off. */
export const outsideMeterOn = (value: string | undefined): boolean => value === "on";

export interface ReportRow {
  tag: string;
  totalCost: number;
  surchargeCost: number;
  requestCount: number;
}

export type ReadOutcome =
  | { kind: "ok"; rows: Map<string, ReportRow> }
  | { kind: "http"; status: number }
  /** A 200 whose body is not the documented `{"results":[...]}` shape: a contract break (C8 3.1). */
  | { kind: "contract" }
  | { kind: "transient" };

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The report URL with exactly the six documented parameters; it never asks for `gateway_cost`. */
export function reportUrl(p: { base?: string; startDay: Date; today: Date; tags: readonly string[] }): URL {
  if (p.tags.length < 1 || p.tags.length > MAX_TAGS_PER_QUERY) throw new Error("gateway report: 1 to 50 tags per query");
  const url = new URL("/v1/report", p.base ?? GATEWAY_BASE_URL);
  url.searchParams.set("start_date", utcDay(p.startDay));
  url.searchParams.set("end_date", utcDay(p.today));
  url.searchParams.set("group_by", "tag");
  url.searchParams.set("tags", p.tags.join(","));
  url.searchParams.set("tags_match", "any");
  url.searchParams.set("api_key_id", "self");
  return url;
}

/** The documented shape only: `{"results":[{tag, total_cost, surcharge_cost, request_count, ...}]}`. Anything else, a row missing a field included, is undefined. */
function parseRows(body: unknown, wanted: ReadonlySet<string>): Map<string, ReportRow> | undefined {
  const list = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as { results?: unknown }).results : undefined;
  if (!Array.isArray(list)) return undefined;
  const rows = new Map<string, ReportRow>();
  for (const r of list as Record<string, unknown>[]) {
    if (r === null || typeof r !== "object" || typeof r.tag !== "string") return undefined;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);
    const row = { tag: r.tag, totalCost: num(r.total_cost), surchargeCost: num(r.surcharge_cost), requestCount: num(r.request_count) };
    if (![row.totalCost, row.surchargeCost, row.requestCount].every(Number.isFinite)) return undefined;
    // Rows for tags we did not ask for (the VM added its own) are ignored.
    if (wanted.has(r.tag)) rows.set(r.tag, row);
  }
  return rows;
}

/** One report read with the connection's own key. Never throws and never logs the key. */
export async function readGatewayReport(p: {
  base?: string;
  apiKey: string;
  tags: readonly string[];
  startDay: Date;
  today: Date;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<ReadOutcome> {
  try {
    const res = await (p.fetchFn ?? fetch)(reportUrl(p), {
      headers: { authorization: `Bearer ${p.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(p.timeoutMs ?? 15_000),
      // The report endpoint never redirects; the tenant's key must not follow one anywhere.
      redirect: "error",
    });
    // 5xx, 408 (request timeout) and 429 (rate limit) change no state; the next scheduled read is tried.
    if (res.status !== 200) return res.status >= 500 || res.status === 408 || res.status === 429 ? { kind: "transient" } : { kind: "http", status: res.status };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // fx-swallow-ok: an unparseable body is a contract break, returned as a fixed kind; the body and key are never logged
      return { kind: "contract" };
    }
    const rows = parseRows(body, new Set(p.tags));
    return rows ? { kind: "ok", rows } : { kind: "contract" };
  } catch (e) {
    // A redirect is a contract break (C10 4); fetch reports it as a TypeError whose cause says so.
    if (e instanceof TypeError && (e.cause as { message?: unknown } | undefined)?.message === "unexpected redirect") return { kind: "contract" };
    // fx-swallow-ok: a network error or timeout changes no state and the next scheduled read is tried; the error text can carry the URL
    return { kind: "transient" };
  }
}

/** When read number `readsDone + 1` falls due, or undefined once all 8 are used. */
export const nextReadDueAt = (finalizedAt: Date, readsDone: number): Date | undefined =>
  readsDone >= MAX_READS ? undefined : new Date(finalizedAt.getTime() + READ_DELAYS_MS[readsDone]!);

/**
 * Final when two consecutive reads agree on cost and count, the count is at least 1, and it is at least the number of
 * model responses the runner metered. A NULL runner count (a run that never wrote one) drops the last condition.
 */
export function isFinal(prev: ReportRow | undefined, cur: ReportRow | undefined, meteredCalls: number | null): boolean {
  if (!prev || !cur) return false;
  if (prev.totalCost !== cur.totalCost || prev.requestCount !== cur.requestCount) return false;
  if (cur.requestCount < 1) return false;
  return meteredCalls === null || cur.requestCount >= meteredCalls;
}

const micro = (usd: number): number => Math.round(usd * 1e6);
export const roundUsd = (usd: number): number => micro(usd) / 1e6;

export interface Comparison {
  /** g: the gateway's figure without our own tag-write surcharge. Never `gateway_cost`. */
  gatewayUsd: number;
  settledUsd: number;
  /** Amount of the one true-up line; 0 when none (a lower gateway figure never credits). */
  trueUpUsd: number;
  disagree: boolean;
  escalate: boolean;
}

export function compareToMeter(meteredUsd: number, row: Pick<ReportRow, "totalCost" | "surchargeCost">): Comparison {
  const g = micro(row.totalCost - row.surchargeCost);
  const m = micro(meteredUsd);
  const diff = Math.abs(g - m);
  const big = Math.max(g, m);
  return {
    gatewayUsd: g / 1e6,
    settledUsd: big / 1e6,
    trueUpUsd: g > m ? (g - m) / 1e6 : 0,
    disagree: diff > Math.max(micro(0.01), 0.02 * big),
    escalate: diff > 0.1 * big && diff > micro(0.1),
  };
}

/** This run's cost of checking: its own tag-write surcharge plus its share of each read it took part in. */
export const overheadUsd = (surchargeCost: number, runsPerRead: readonly number[]): number =>
  roundUsd(surchargeCost + runsPerRead.reduce((sum, n) => sum + GATEWAY_PRICES.reportQueryUsd / Math.max(n, 1), 0));

export type Entitlement = "unknown" | "yes" | "no";

/** `no` is forgotten when the key changed or after 7 days. */
export function effectiveEntitlement(e: { value: Entitlement; setAt: Date | null }, now: Date, keyChanged: boolean): Entitlement {
  if (keyChanged) return "unknown";
  if (e.value === "no" && e.setAt && now.getTime() - e.setAt.getTime() >= ENTITLEMENT_NO_TTL_MS) return "unknown";
  return e.value;
}

export type UnavailableReason =
  | "not_stable" | "no_rows" | "plan_not_entitled" | "auth_failed" | "bad_request" | "flag_off" | "connection_changed" | "contract_mismatch";

/** What one read's outcome does, before the comparison: the entitlement it sets and what happens to the run. */
export function interpretRead(
  out: ReadOutcome,
  lastRead: boolean,
): { entitlement?: Entitlement; flag?: "outside_meter_contract"; run: "read" | "keep" | { unavailable: UnavailableReason; flag?: boolean } } {
  // A contract break changes nothing, raises the flag, and ends the run only if it is the last read.
  if (out.kind === "contract") return { flag: "outside_meter_contract", run: lastRead ? { unavailable: "contract_mismatch" } : "keep" };
  if (out.kind === "ok") return { entitlement: "yes", run: "read" };
  if (out.kind === "transient") return { run: "keep" };
  if (out.status === 403) return { entitlement: "no", run: { unavailable: "plan_not_entitled" } };
  if (out.status === 401) return { run: lastRead ? { unavailable: "auth_failed" } : "keep" };
  return { run: { unavailable: "bad_request", flag: true } };
}

export type OutsideMeterState =
  | { state: "pending" }
  | { state: "matches" }
  | { state: "higher"; addedUsd: number }
  | { state: "unavailable"; reason: UnavailableReason }
  | { state: "off" };

/** The five run-detail lines; never null or undefined. */
export function outsideMeterLabel(s: OutsideMeterState): string {
  switch (s.state) {
    case "pending":
      return "Checking with the AI Gateway";
    case "matches":
      return "Matches the gateway";
    case "higher":
      return `Gateway figure higher: $${s.addedUsd.toFixed(2)} added`;
    case "unavailable":
      return `Outside check unavailable: ${s.reason.replaceAll("_", " ")}`;
    case "off":
      return "Outside check off";
  }
}

/** For the backend picker (R3-3): GA only with the flag on and an entitlement that is not `no`. */
export function outsideMeterStatus(
  flagOn: boolean,
  entitlement: Entitlement,
): { label: "ga" } | { label: "beta"; reason: "flag_off" | "plan_not_entitled" } {
  if (!flagOn) return { label: "beta", reason: "flag_off" };
  return entitlement === "no" ? { label: "beta", reason: "plan_not_entitled" } : { label: "ga" };
}
