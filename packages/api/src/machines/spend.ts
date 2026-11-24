import type { PoolClient } from "pg";
import { computeUsd, priceFor, TIER_TO_MODEL_ID } from "@fx/spend";
import { utcMonthStart } from "@fx/core/src/time.js";
import { RUNNER_SIGN_IN_KIND_SQL, type RunnerSignInKind } from "@fx/db/src/runnerSignIn.js";

/**
 * D#845 MC-11b: the two machine figures of Budget & billing, answered whole so the page does no arithmetic.
 *
 * Servers this month (Hetzner Cloud servers we created, from `managed_servers`): for each server, running hours in this UTC month, then
 * min(hours x hourly, monthly) + IPv4, all from the gross prices stamped when the server was made (never today's list price, never a constant).
 * Hours run from the row's `created_at` to its `deleted_at` (or now), clipped to the month, and are rounded UP to whole started hours, as Hetzner bills them
 * (a 30-minute server is one hour); the hours shown are those billed hours. The IPv4 figure is min(hours x the stamped hourly IPv4 price, the stamped monthly one).
 * A server made before the hourly IPv4 price was stamped has none: its IPv4 is the monthly price in full and the server is marked `estimate`. An hourly rate is never
 * worked out from the monthly one.
 * A row with no provider server id never reached Hetzner and costs nothing. A row with no stamped price (the orphan sweep makes those) is listed
 * with no cost, counted in `unpriced_count`, and left out of the totals. Totals are per currency, so two currencies are never added together.
 * The sums are done by Postgres on numeric, never by float.
 *
 * Claude usage this month (`machine_usage_daily`, MC-11a's rollup): token counts per machine and project for the UTC days of this month, summed over
 * sources and days, and priced with the cloud's own price table (`@fx/spend` pricing, the plan data) as "about $X at API prices". The engine and the runner send
 * tokens, never a dollar amount. A tier with no price row keeps its tokens and has no dollar figure, and says so (`priced: false`); it is never priced at zero.
 * The total of dollars is the sum of the priced rows in whole ten-thousandths, so a machine's figure equals the sum of its projects' figures exactly.
 *
 * Every query names the account, on top of row security. Money and token counts leave as strings or integers the page prints as they are.
 */

export const SERVER_PRICE_NOTE = "Estimated from Hetzner's list price. Hetzner bills you directly";
export const SERVER_ESTIMATE_NOTE = "Estimate: this server was made before its hourly IPv4 price was recorded, so its IPv4 is counted at the full monthly price";
export const USAGE_PRICE_NOTE = "at API prices";
/** How a machine's Claude usage is paid (owner ruling 88.0a), from `runnerSignInKind`. `unknown` has no line. */
export const USAGE_PAID_NOTE: Record<RunnerSignInKind, string | null> = {
  subscription: "Covered by your Claude plan; shown at API prices for comparison",
  api_key: "Billed to your API key",
  unknown: null,
};

export interface ServerSpendRow {
  id: string;
  name: string;
  server_type: string | null;
  location: string | null;
  running: boolean;
  /** Hours billed this month: running time rounded up to whole started hours. */
  hours: string;
  currency: string;
  /** Null when no price was stamped. Four decimals. */
  cost: string | null;
  /** True when the cost uses the full monthly IPv4 price because no hourly one was recorded for this server. */
  estimate: boolean;
}
export interface ServerSpend {
  note: string;
  /** Set when any listed server is an estimate; says why. */
  estimate_note: string | null;
  totals: { currency: string; amount: string }[];
  unpriced_count: number;
  /** The per-server rows (name, size, location) are for owners and admins; a member gets null here and the totals above. */
  servers: ServerSpendRow[] | null;
}

export interface UsageTokens { input_tokens: string; output_tokens: string; cache_read_tokens: string; cache_write_tokens: string }
export interface UsageProject extends UsageTokens {
  repo_id: string | null;
  /** `owner/name`, or null for a project that was removed (its rows stay, without a repo). */
  name: string | null;
  api_equivalent_usd: number | null;
  /** False when some of its tokens are on a model with no price: the dollar figure then covers only the priced part. */
  priced: boolean;
}
export interface UsageMachine extends UsageTokens {
  runner_id: string;
  name: string | null;
  api_equivalent_usd: number | null;
  priced: boolean;
  /** How Claude is signed in on this machine now: a derived fact (`runnerSignInKind`), never stored. */
  sign_in_kind: RunnerSignInKind;
  /** The one line saying who pays for this machine's usage; null when the sign-in kind is unknown. */
  paid_note: string | null;
  projects: UsageProject[];
}
export interface ClaudeUsage extends UsageTokens {
  note: string;
  api_equivalent_usd: number | null;
  priced: boolean;
  machines: UsageMachine[];
}

export interface MachineSpend {
  period_start: string;
  period_end: string;
  as_of: string;
  servers: ServerSpend;
  usage: ClaudeUsage;
}

function nextMonthStart(start: Date): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

interface ServerRow {
  id: string; name: string; server_type: string | null; location: string | null; running: boolean; hours: string; currency: string; cost: string | null; estimate: boolean; currency_total: string | null; priced_n: string;
}

async function readServers(client: PoolClient, accountId: string, from: Date, to: Date, now: Date, withRows: boolean): Promise<ServerSpend> {
  // `window_end` is the earlier of now and the month's end, so a month already over counts to its end and the running month counts to now.
  const { rows } = await client.query<ServerRow>(
    `WITH w AS (SELECT $2::timestamptz AS ws, LEAST($4::timestamptz, $3::timestamptz) AS we),
          s AS (
            SELECT m.id, m.name, m.server_type, m.location, (m.deleted_at IS NULL) AS running, m.created_at, m.currency,
                   m.price_hourly_gross, m.price_monthly_gross, m.ipv4_monthly_gross, m.ipv4_hourly_gross,
                   CEIL(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(m.deleted_at, w.we), w.we) - GREATEST(m.created_at, w.ws))))::numeric / 3600) AS hours
              FROM managed_servers m, w
             WHERE m.account_id = $1 AND m.provider_server_id IS NOT NULL
               AND m.created_at < w.we AND (m.deleted_at IS NULL OR m.deleted_at > w.ws)
          ),
          c AS (
            SELECT s.*, CASE WHEN price_hourly_gross IS NULL OR price_monthly_gross IS NULL OR ipv4_monthly_gross IS NULL THEN NULL
                             ELSE ROUND(LEAST(hours * price_hourly_gross, price_monthly_gross)
                                        + CASE WHEN ipv4_hourly_gross IS NULL THEN ipv4_monthly_gross ELSE LEAST(hours * ipv4_hourly_gross, ipv4_monthly_gross) END, 4) END AS cost,
                   (ipv4_hourly_gross IS NULL AND price_hourly_gross IS NOT NULL AND price_monthly_gross IS NOT NULL AND ipv4_monthly_gross IS NOT NULL) AS estimate
              FROM s
          )
     SELECT id, name, server_type, location, running, hours::text AS hours, currency, cost::text AS cost, estimate,
            (SUM(cost) OVER (PARTITION BY currency))::text AS currency_total,
            (COUNT(cost) OVER (PARTITION BY currency))::text AS priced_n
       FROM c ORDER BY created_at, id`,
    [accountId, from, to, now],
  );
  const totals = new Map<string, string>();
  for (const r of rows) if (r.currency_total !== null && !totals.has(r.currency)) totals.set(r.currency, r.currency_total);
  return {
    note: SERVER_PRICE_NOTE,
    estimate_note: rows.some((r) => r.estimate) ? SERVER_ESTIMATE_NOTE : null,
    totals: [...totals].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => a.currency.localeCompare(b.currency)),
    unpriced_count: rows.filter((r) => r.cost === null).length,
    servers: withRows ? rows.map((r) => ({ id: r.id, name: r.name, server_type: r.server_type, location: r.location, running: r.running, hours: r.hours, currency: r.currency, cost: r.cost, estimate: r.estimate })) : null,
  };
}

/** Whole ten-thousandths of a dollar for a tier's tokens, or null when the tier has no price (or the plan data is not loaded). */
function priceTier(tier: string, t: { input: bigint; output: bigint; cacheRead: bigint; cacheWrite: bigint }): number | null {
  try {
    // Every price lookup is inside the try: with no plan data even the first one throws, and the answer is an empty dollar figure, not a failed route.
    const id = priceFor("claude-code", tier) !== undefined ? tier : Object.hasOwn(TIER_TO_MODEL_ID, tier) ? TIER_TO_MODEL_ID[tier] : undefined;
    if (id === undefined) return null;
    const rate = priceFor("claude-code", id);
    if (rate === undefined) return null;
    const usd = computeUsd(rate, { inputTokens: Number(t.input), outputTokens: Number(t.output), cacheReadTokens: Number(t.cacheRead), cacheWriteTokens: Number(t.cacheWrite) });
    return Math.round(usd * 10_000);
  } catch (error) {
    // Without plan data there is no price table: the tokens stay and the figure is empty, never zero.
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "plan_data_unavailable") return null;
    throw error;
  }
}

interface UsageRow {
  runner_id: string; runner_name: string | null; sign_in_kind: RunnerSignInKind; repo_id: string | null; gh_owner: string | null; gh_name: string | null; model_tier: string;
  input_tokens: string; output_tokens: string; cache_read_tokens: string; cache_write_tokens: string;
}

interface Acc { input: bigint; output: bigint; cacheRead: bigint; cacheWrite: bigint; tenThousandths: number; unpriced: boolean }
const acc = (): Acc => ({ input: 0n, output: 0n, cacheRead: 0n, cacheWrite: 0n, tenThousandths: 0, unpriced: false });
function add(a: Acc, t: { input: bigint; output: bigint; cacheRead: bigint; cacheWrite: bigint }, cents: number | null): void {
  a.input += t.input; a.output += t.output; a.cacheRead += t.cacheRead; a.cacheWrite += t.cacheWrite;
  if (cents === null) a.unpriced = true;
  else a.tenThousandths += cents;
}
const tokens = (a: Acc): UsageTokens => ({ input_tokens: String(a.input), output_tokens: String(a.output), cache_read_tokens: String(a.cacheRead), cache_write_tokens: String(a.cacheWrite) });
const dollars = (a: Acc): number | null => (a.tenThousandths === 0 && a.unpriced ? null : a.tenThousandths / 10_000);

async function readUsage(client: PoolClient, accountId: string, from: Date, to: Date): Promise<ClaudeUsage> {
  const { rows } = await client.query<UsageRow>(
    `SELECT u.runner_id, rs.name AS runner_name, ${RUNNER_SIGN_IN_KIND_SQL("rn")} AS sign_in_kind, u.repo_id, r.gh_owner, r.gh_name, u.model_tier,
            SUM(u.input_tokens)::text AS input_tokens, SUM(u.output_tokens)::text AS output_tokens,
            SUM(u.cache_read_tokens)::text AS cache_read_tokens, SUM(u.cache_write_tokens)::text AS cache_write_tokens
       FROM machine_usage_daily u
       LEFT JOIN runner_settings rs ON rs.account_id = u.account_id AND rs.runner_id = u.runner_id
       LEFT JOIN runners rn ON rn.account_id = u.account_id AND rn.id = u.runner_id
       LEFT JOIN repos r ON r.account_id = u.account_id AND r.id = u.repo_id
      WHERE u.account_id = $1 AND u.day >= $2::date AND u.day < $3::date
      GROUP BY u.runner_id, rs.name, ${RUNNER_SIGN_IN_KIND_SQL("rn")}, u.repo_id, r.gh_owner, r.gh_name, u.model_tier
      ORDER BY u.runner_id, u.repo_id NULLS LAST, u.model_tier`,
    [accountId, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
  );
  const total = acc();
  const machines = new Map<string, { name: string | null; kind: RunnerSignInKind; acc: Acc; projects: Map<string, { name: string | null; repo: string | null; acc: Acc }> }>();
  for (const r of rows) {
    const t = { input: BigInt(r.input_tokens), output: BigInt(r.output_tokens), cacheRead: BigInt(r.cache_read_tokens), cacheWrite: BigInt(r.cache_write_tokens) };
    if (t.input + t.output + t.cacheRead + t.cacheWrite === 0n) continue;
    const cents = priceTier(r.model_tier, t);
    let m = machines.get(r.runner_id);
    if (!m) machines.set(r.runner_id, (m = { name: r.runner_name, kind: r.sign_in_kind, acc: acc(), projects: new Map() }));
    const key = r.repo_id ?? "none";
    let p = m.projects.get(key);
    if (!p) m.projects.set(key, (p = { repo: r.repo_id, name: r.gh_owner !== null && r.gh_name !== null ? `${r.gh_owner}/${r.gh_name}` : null, acc: acc() }));
    add(p.acc, t, cents); add(m.acc, t, cents); add(total, t, cents);
  }
  return {
    note: USAGE_PRICE_NOTE,
    ...tokens(total),
    api_equivalent_usd: dollars(total),
    priced: !total.unpriced,
    machines: [...machines].map(([runner_id, m]) => ({
      runner_id, name: m.name, ...tokens(m.acc), api_equivalent_usd: dollars(m.acc), priced: !m.acc.unpriced, sign_in_kind: m.kind, paid_note: USAGE_PAID_NOTE[m.kind],
      projects: [...m.projects.values()].map((p) => ({ repo_id: p.repo, name: p.name, ...tokens(p.acc), api_equivalent_usd: dollars(p.acc), priced: !p.acc.unpriced })),
    })),
  };
}

/** Inside the caller's tenant transaction. */
export async function readMachineSpend(client: PoolClient, accountId: string, opts: { includeServerRows: boolean }, now: Date = new Date()): Promise<MachineSpend> {
  const from = utcMonthStart(now);
  const to = nextMonthStart(from);
  return {
    period_start: from.toISOString(),
    period_end: to.toISOString(),
    as_of: now.toISOString(),
    servers: await readServers(client, accountId, from, to, now, opts.includeServerRows),
    usage: await readUsage(client, accountId, from, to),
  };
}
