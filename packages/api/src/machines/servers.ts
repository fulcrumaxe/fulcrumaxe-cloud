import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { HetznerError, MANAGED_LABEL, MANAGED_LABEL_VALUE, createHetznerClient, type HetznerClient, type HetznerCode, type HetznerOptions } from "@fx/hetzner";
import { MachineOpsError, machineKekSource, withHetznerToken, type KekSource } from "@fx/model-connection";
import { reportError } from "@fx/telemetry";
import { RunnerHttpError, mintServerProvisioningToken, renderUserData, revokeProvisioningToken, type RunnerCloudDeps } from "@fx/runner-cloud";
import { withTenant } from "@fx/db/src/withTenant.js";
import { ApiError } from "../errors.js";

/**
 * D#845 MC-4: quote and create a Hetzner Cloud server with the person's own token.
 *
 * Money. Nothing here guesses a price. The quote reads Hetzner's live `/pricing` and `/server_types` through the typed client; when Hetzner does not answer, the
 * answer is 503 and no price is shown. Create reads the live price again and refuses (409 `price_changed`, nothing created) when the price the person was shown
 * differs from it by any amount. The price is stamped into the row when it is made (the columns are not updatable afterwards), so what was agreed is what is kept.
 *
 * Order of a create, each step undone by the ones after it if it fails (a test per point): the price check, the firewall, the `fxrp_` token, the server's row (the
 * stamp), the server, then the IP and the audit row in one transaction. The server is made with an IPv4 address and no IPv6 one: the token-to-IP binding (MC-5) compares
 * an IPv4 source address, so a server that could reach the cloud over IPv6 would be refused as `token_bound_elsewhere`. Pinning IPv4 is the whole answer to that.
 *
 * Idempotency. One key makes one server. A transaction-scoped advisory lock on (account, key) serialises the requests that carry the same key, so the second one
 * waits and then finds the first one's row instead of starting its own; the unique index on (account, key) is the backstop under that. A key that already has a row
 * answers that row, whatever state it is in, and calls nothing. A second advisory lock, on the account alone, is tried (never waited for) after that: a create under a new key
 * while another is running answers 409 `server_creating`, so a reload or a second tab cannot make a second billed server.
 *
 * A crash between two steps (the process dies, not an error) leaves a labelled firewall or server and no finished row: the orphan sweep (MC-7) finds those by their labels.
 */

/** The standard-tier statement of §1.4 step 2, shown before any price. One constant, so the dialog, the quote and the test read the same words. */
export const STANDARD_TIER_NOTICE =
  "Hetzner Cloud servers can't run microVMs (Hetzner doesn't offer nested virtualization on cloud servers). This server will use Standard isolation and host one project. For microVM isolation, add a server you already have that has KVM (see 'A computer or server I have').";
export const BILLED_BY_NOTICE = "Hetzner bills you directly";
export const SERVER_IMAGE = "ubuntu-24.04";

const MONEY = /^[0-9]{1,6}(\.[0-9]{1,6})?$/;
const trimMoney = (s: string): string => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
/** True when two decimal strings are the same amount ("3.7900" and "3.79" are). Both must be plain decimals. */
export const sameMoney = (a: string, b: string): boolean => MONEY.test(a) && MONEY.test(b) && trimMoney(a) === trimMoney(b);

export interface PriceTriple { currency: string; hourly_gross: string; monthly_gross: string; ipv4_monthly_gross: string }
export interface ServerQuote extends PriceTriple {
  /** First on purpose: the tier is read before the price. */
  tier: "standard";
  tier_notice: string;
  billed_by: string;
  server_type: string;
  location: string;
  available: boolean;
}
export interface ServerView {
  id: string;
  name: string;
  kind: "hetzner_cloud";
  status: string;
  server_type: string | null;
  location: string | null;
  public_ipv4: string | null;
  failure_code: string | null;
  price: PriceTriple | null;
  created_at: string;
}

/** Test seams. Production wiring: the machine KEK and the public origin come from the environment, Hetzner is the real API over TLS. */
export const machineServerDeps: {
  getKek: () => KekSource;
  getOrigin: () => string | undefined;
  hetznerOptions: () => Omit<HetznerOptions, "token">;
  /** Called at the named step of a create, tests only (ignored unless NODE_ENV is "test"): a throw there is a failure at that point. */
  checkpoint?: (step: CreateStep) => void | Promise<void>;
  /** MC-7: starts the queued status worker of a new server (a Workflow in production, wired by the web app). Absent: nothing is started, and the row stays as the create left it. */
  startStatusWorker?: (a: { accountId: string; userId: string; serverId: string }) => Promise<unknown>;
  /** MC-7: the worker's lease-fail port, which `revokeRunner` needs. Absent, a delete that has a runner to revoke answers 503 `leases_not_failed` after the revoke. */
  failRunnerLeases?: RunnerCloudDeps["failRunnerLeases"];
  /** MC-7: removes the projects placed on a machine (ON-16, wired by MC-12). Absent: a delete asked to remove projects answers 409 `project_removal_unavailable`. */
  removeProjects?: (ctx: ServerCtx, runnerId: string) => Promise<void>;
  /** MC-7: how long a delete waits between two looks at Hetzner's delete action. */
  actionWaitMs?: number;
} = {
  getKek: () => machineKekSource(),
  getOrigin: () => process.env.FX_APP_ORIGIN,
  hetznerOptions: () => ({}),
};
export type CreateStep = "price" | "firewall" | "token" | "render" | "insert" | "server" | "finalize" | "audit";
const checkpoint = async (step: CreateStep): Promise<void> => {
  if (process.env.NODE_ENV === "test") await machineServerDeps.checkpoint?.(step);
};

/** Hetzner's own words are never passed on: each code has fixed plain copy, and the code itself is the stamp on a failed row. */
const HETZNER_ANSWER: Record<HetznerCode, { status: number; message: string }> = {
  unauthorized: { status: 409, message: "Hetzner refused the stored token. It may have been revoked. Remove it and add a new one" },
  forbidden: { status: 409, message: "The Hetzner token can't do that. It needs Read & Write access" },
  resource_limit_exceeded: { status: 409, message: "Hetzner's server limit for your Hetzner account was reached. Ask Hetzner to raise it, or delete a server" },
  resource_unavailable: { status: 409, message: "That size isn't available in this location right now. Choose another size or location" },
  placement_error: { status: 409, message: "That size isn't available in this location right now. Choose another size or location" },
  rate_limit_exceeded: { status: 429, message: "Hetzner asked us to slow down. Try again in a minute" },
  uniqueness_error: { status: 409, message: "Hetzner says that name is already used. Choose another name" },
  invalid_input: { status: 422, message: "Hetzner refused the request as invalid" },
  server_error: { status: 503, message: "Hetzner didn't answer. Try again in a minute" },
  unavailable: { status: 503, message: "Hetzner didn't answer. Try again in a minute" },
  not_found: { status: 409, message: "Hetzner doesn't have something this request names (an SSH key, for one)" },
  locked: { status: 409, message: "Hetzner reports the item is busy. Try again in a minute" },
};
export const failureCodeOf = (e: unknown): string => (e instanceof HetznerError ? `hetzner_${e.code}` : "create_failed");
/** A Hetzner error as the API error a caller sees; anything else passes through. */
export function toApiError(e: unknown): unknown {
  // The token service speaks RunnerHttpError (fixed text and a closed code, such as 409 `token_limit`); this API speaks ApiError.
  if (e instanceof RunnerHttpError) return new ApiError(e.status, e.code, e.message);
  if (!(e instanceof HetznerError)) return e;
  const a = HETZNER_ANSWER[e.code];
  return new ApiError(a.status, `hetzner_${e.code}`, a.message, undefined, e.retryAfter === undefined ? undefined : { retry_after: e.retryAfter });
}

export interface Caller { accountId: string; userId: string }
export interface ServerCtx { pool: Pool; principal: Caller }

export const clientFor = (token: string): HetznerClient => {
  try {
    return createHetznerClient({ ...machineServerDeps.hetznerOptions(), token });
  } catch (e) {
    // fx-swallow-ok: a token the client refuses to hold is one Hetzner does not issue; the error names no value
    if (e instanceof HetznerError) throw new MachineOpsError("credential_invalid");
    throw e;
  }
};
const opsCtx = (ctx: ServerCtx) => ({ pool: ctx.pool, principal: ctx.principal, kek: machineServerDeps.getKek() });

/**
 * The one door to the stored Hetzner token for the rest of the machines code: it opens the token through the machine-ops reader (which writes the audit row for the unseal)
 * and hands `f` a Hetzner client, never the token itself. Other files in this folder (the server lifecycle) call this and name no machine-ops symbol of their own,
 * which keeps the set of files that touch the sealed token pinned by the static guard in model-connection.
 */
export const withHetznerClient = <T>(ctx: ServerCtx, f: (client: HetznerClient) => Promise<T>): Promise<T> => withHetznerToken(opsCtx(ctx), (token) => f(clientFor(token)));

/** The live prices of one size in one location, or null when Hetzner does not list a price there. Reads nothing but Hetzner. */
async function livePrice(client: HetznerClient, serverType: string, location: string): Promise<(PriceTriple & { available: boolean }) | null> {
  const [pricing, types] = await Promise.all([client.getPricing(), client.listServerTypes()]);
  const price = pricing.serverTypes.find((t) => t.name === serverType)?.prices.find((p) => p.location === location);
  const ipv4 = pricing.primaryIps.find((p) => p.type === "ipv4")?.prices.find((p) => p.location === location);
  const type = types.find((t) => t.name === serverType);
  if (!price || !ipv4 || !type) return null;
  return { currency: pricing.currency, hourly_gross: price.hourlyGross, monthly_gross: price.monthlyGross, ipv4_monthly_gross: ipv4.monthlyGross, available: type.locations.some((l) => l.name === location && l.available) };
}
const noPrice = (): ApiError => new ApiError(503, "price_unavailable", "Prices couldn't be loaded");

/** GET quote. Owner or admin (the stored token is opened for it). A Hetzner failure of any kind is 503 and carries no price. */
export async function quoteServer(ctx: ServerCtx, input: { serverType: string; location: string }): Promise<ServerQuote> {
  try {
    const live = await withHetznerToken(opsCtx(ctx), (token) => livePrice(clientFor(token), input.serverType, input.location));
    if (live === null) throw new ApiError(422, "unknown_size", "Hetzner doesn't offer that size in that location");
    return {
      tier: "standard", tier_notice: STANDARD_TIER_NOTICE, billed_by: BILLED_BY_NOTICE, server_type: input.serverType, location: input.location, available: live.available,
      currency: live.currency, hourly_gross: live.hourly_gross, monthly_gross: live.monthly_gross, ipv4_monthly_gross: live.ipv4_monthly_gross,
    };
  } catch (e) {
    if (e instanceof HetznerError && e.code !== "unauthorized") throw noPrice();
    throw toApiError(e);
  }
}

interface Row {
  id: string; name: string; status: string; server_type: string | null; location: string | null; public_ipv4: string | null; failure_code: string | null;
  price_hourly_gross: string | null; price_monthly_gross: string | null; ipv4_monthly_gross: string | null; currency: string; created_at: Date;
}
const COLUMNS = `id, name, status, server_type, location, host(public_ipv4) AS public_ipv4, failure_code, price_hourly_gross::text, price_monthly_gross::text, ipv4_monthly_gross::text, currency, created_at`;
const viewOf = (r: Row): ServerView => ({
  id: r.id, name: r.name, kind: "hetzner_cloud", status: r.status, server_type: r.server_type, location: r.location, public_ipv4: r.public_ipv4, failure_code: r.failure_code,
  // A server found by the orphan sweep was not made through a create, so no price was stamped: it has none, and says so.
  price: r.price_hourly_gross === null || r.price_monthly_gross === null || r.ipv4_monthly_gross === null ? null : { currency: r.currency, hourly_gross: r.price_hourly_gross, monthly_gross: r.price_monthly_gross, ipv4_monthly_gross: r.ipv4_monthly_gross }, created_at: r.created_at.toISOString(),
});

/** One of the account's servers, or null. The id must be a UUID (the caller checks; a malformed one never reaches the database). */
export async function getServer(ctx: ServerCtx, id: string): Promise<ServerView | null> {
  const row = await withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (c) => (await c.query<Row>(`SELECT ${COLUMNS} FROM managed_servers WHERE account_id = $1 AND id = $2`, [ctx.principal.accountId, id])).rows[0]);
  return row ? viewOf(row) : null;
}

/** The account's servers that are not deleted, newest first, with the fields of `getServer`. The account predicate is explicit, on top of row security. */
export async function listServers(ctx: ServerCtx): Promise<ServerView[]> {
  const { accountId, userId } = ctx.principal;
  const rows = await withTenant(ctx.pool, accountId, userId, async (c) => (await c.query<Row>(`SELECT ${COLUMNS} FROM managed_servers WHERE account_id = $1 AND status <> 'deleted' ORDER BY created_at DESC, id LIMIT 500`, [accountId])).rows);
  return rows.map(viewOf);
}

export interface CreateInput {
  /** The Idempotency-Key header: one key, one server. */
  idempotencyKey: string;
  serverType: string;
  location: string;
  name?: string;
  /** A Hetzner SSH key id in the person's project. With one, port 22 is open to the world on the server's firewall; without, nothing is. */
  sshKeyId?: number;
  /** The price the person was shown. Any difference from the live price is 409 `price_changed`. */
  quoted: PriceTriple;
}

/** What a create has made so far, so that a failure can undo exactly that. */
interface Made { firewallId?: number; tokenId?: string; serverRowId?: string; hetznerServerId?: number; /** The server create was sent (whatever came back): a failure without an id may still be a server that is being made. */ serverSent?: boolean }

/** Hetzner answers that mean the request was refused and nothing was made. Every other failure after a create was sent leaves it unknown whether a server exists. */
const REFUSED = new Set<HetznerCode>(["unauthorized", "forbidden", "resource_limit_exceeded", "resource_unavailable", "placement_error", "invalid_input", "uniqueness_error", "not_found"]);
/** How long the undo waits for a server's delete to finish before the firewall (Hetzner refuses a firewall that is still applied to a server being deleted). */
const DELETE_WAIT_MS = 60_000;

/**
 * Undoes `made`, newest first: the server, then (once its delete has finished) the firewall, which Hetzner refuses to delete while it is applied, the token, and the row is marked failed.
 * When the server create was sent and nothing says whether it landed (any answer but a plain refusal), an empty search by label proves nothing: a create Hetzner is still
 * processing appears later and bills. That row is stamped `cleanup_failed`, never a clean failure, so the sweep and the status worker look again by label.
 */
async function unwind(ctx: ServerCtx, client: HetznerClient, deps: RunnerCloudDeps, serverId: string, made: Made, failureCode: string, cause: unknown): Promise<void> {
  let clean = true;
  const attempt = async (f: () => Promise<unknown>): Promise<boolean> => {
    try { await f(); return true; } catch {
      // fx-swallow-ok: one failed undo must not stop the others; the row below records that something was left, and the sweep finds it by its labels
      return false;
    }
  };
  let serverGone = true;
  const deleteAndWait = async (id: number): Promise<void> => {
    const a = await client.deleteServer(id);
    if (a !== null) await client.waitForAction(a.id, { timeoutMs: DELETE_WAIT_MS });
  };
  if (made.hetznerServerId !== undefined) serverGone = await attempt(() => deleteAndWait(made.hetznerServerId!));
  else if (made.serverRowId !== undefined) {
    // The create may have landed without an answer we could read: look for it by the label the server carries.
    const unconfirmed = made.serverSent === true && !(cause instanceof HetznerError && !cause.ambiguous && REFUSED.has(cause.code));
    serverGone = await attempt(async () => {
      const found = await client.listServers({ labelSelector: `fx-server=${serverId}` });
      for (const s of found) await deleteAndWait(s.id);
      if (unconfirmed && found.length === 0) throw new Error("the create was sent and no server was found: it may still be made");
    });
  }
  clean = serverGone;
  if (made.firewallId !== undefined) clean = (serverGone ? await attempt(() => client.deleteFirewall(made.firewallId!)) : false) && clean;
  if (made.tokenId !== undefined) clean = (await attempt(() => revokeProvisioningToken(deps, ctx.principal, made.tokenId!).catch((e: unknown) => {
    // A token that is already used or revoked answers 404: it can no longer be redeemed, which is what the undo is for.
    if (!(e instanceof RunnerHttpError && e.status === 404)) throw e;
  }))) && clean;
  if (made.serverRowId !== undefined) {
    await withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, (c) =>
      c.query(
        `UPDATE managed_servers SET status = 'failed', status_at = now(), failure_code = $3, provider_server_id = $4, provider_firewall_id = $5
          WHERE account_id = $1 AND id = $2 AND status <> 'deleted'`,
        [ctx.principal.accountId, serverId, clean ? failureCode : "cleanup_failed", clean || made.hetznerServerId === undefined ? null : String(made.hetznerServerId), clean || made.firewallId === undefined ? null : String(made.firewallId)],
      ),
    );
  }
}

const KEY_LOCK_TIMEOUT = "120s";

/**
 * POST create. Owner or admin. Returns the server and whether it is the answer to an earlier request with the same key.
 * The advisory lock lives on one connection for the whole flow (a transaction that does nothing else), so a second request with the same key waits for the first.
 */
export async function createServer(ctx: ServerCtx, input: CreateInput): Promise<{ server: ServerView; reused: boolean }> {
  const release = await takeCreateSlot(ctx.pool);
  try {
    return await createUnderLock(ctx, input);
  } finally {
    release();
  }
}

/**
 * A create holds one pool connection (the advisory lock) for its whole flow, and every step of the flow takes a second one for a moment. If as many creates ran at once as the
 * pool has connections, each would hold its first and wait for a second that none can give: a deadlock the lock timeout cannot see, because nobody waits on the lock. So at most
 * (pool size - 1) creates hold a lock connection at once per pool; at least one connection is never held by a create, and each flow gets it in turn. Waiting here holds no
 * connection, and gives up after SLOT_WAIT_MS with a 503 instead of hanging.
 */
const SLOT_WAIT_MS = 60_000;
const slots = new WeakMap<Pool, { used: number; waiters: Array<() => void> }>();
async function takeCreateSlot(pool: Pool): Promise<() => void> {
  const max = Math.max(1, (pool.options.max ?? 10) - 1);
  let st = slots.get(pool);
  if (!st) { st = { used: 0, waiters: [] }; slots.set(pool, st); }
  const state = st;
  if (state.used >= max) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.waiters.splice(state.waiters.indexOf(wake), 1);
        reject(new ApiError(503, "busy", "Too many servers are being made right now. Try again in a minute"));
      }, SLOT_WAIT_MS);
      const wake = (): void => { clearTimeout(timer); resolve(); };
      state.waiters.push(wake);
    });
  } else state.used++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = state.waiters.shift();
    if (next) next(); // the slot passes to the next waiter, so `used` is unchanged
    else state.used--;
  };
}

async function createUnderLock(ctx: ServerCtx, input: CreateInput): Promise<{ server: ServerView; reused: boolean }> {
  const lock = await ctx.pool.connect();
  let broken = false;
  try {
    await lock.query("BEGIN");
    await lock.query(`SET LOCAL lock_timeout = '${KEY_LOCK_TIMEOUT}'`);
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`machine-server-create:${ctx.principal.accountId}:${input.idempotencyKey}`]);
    return await createLocked(ctx, input, lock);
  } catch (e) {
    broken = true;
    throw e;
  } finally {
    try { await lock.query(broken ? "ROLLBACK" : "COMMIT"); } catch {
      // fx-swallow-ok: the connection is dropped below, which ends the transaction and frees the lock either way
      broken = true;
    }
    lock.release(broken);
  }
}

/** How long a `creating` row with no Hetzner id still counts as a create in progress, when its lock is gone (a create that was killed). */
const CREATING_WINDOW = "10 minutes";
const SERVER_CREATING = "A server is already being made for this account. Wait for it to finish, then try again";

async function createLocked(ctx: ServerCtx, input: CreateInput, lock: PoolClient): Promise<{ server: ServerView; reused: boolean }> {
  const { accountId, userId } = ctx.principal;
  const existing = await withTenant(ctx.pool, accountId, userId, async (c) => (await c.query<Row>(`SELECT ${COLUMNS} FROM managed_servers WHERE account_id = $1 AND idempotency_key = $2`, [accountId, input.idempotencyKey])).rows[0]);
  if (existing) return { server: viewOf(existing), reused: true };
  // One create per account at a time, whatever the key: a reload or a second tab has lost the first key. The per-key lock above is already held, so a retry with the same key
  // has been answered by the lookup above and never gets here. This one does not wait, and it is held (on the same transaction) for as long as the per-key lock.
  const got = await lock.query<{ got: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got", [`machine-server-create-account:${accountId}`]);
  if (got.rows[0]?.got !== true) throw new ApiError(409, "server_creating", SERVER_CREATING);
  // A create is several transactions (the row is committed before the Hetzner calls), so a create killed after its row, before the server, holds no lock but may still have
  // a server landing at Hetzner. Its row, with no Hetzner id yet and under another key, blocks a new create for a few minutes. A finished create has its id and does not.
  const busy = await withTenant(ctx.pool, accountId, userId, async (c) => (await c.query(
    `SELECT 1 FROM managed_servers WHERE account_id = $1 AND status = 'creating' AND provider_server_id IS NULL AND idempotency_key IS DISTINCT FROM $2 AND created_at > now() - interval '${CREATING_WINDOW}' LIMIT 1`,
    [accountId, input.idempotencyKey])).rowCount);
  if (busy) throw new ApiError(409, "server_creating", SERVER_CREATING);
  const origin = machineServerDeps.getOrigin();
  if (origin === undefined || origin === "") throw new ApiError(503, "not_configured", "Hetzner Cloud servers are not available right now");

  const deps: RunnerCloudDeps = { appUserPool: ctx.pool, origin, failRunnerLeases: null };
  const serverId = randomUUID();
  const name = input.name ?? `fx-${serverId.slice(0, 8)}`;
  const made: Made = {};
  let client: HetznerClient | undefined;
  try {
    return await withHetznerToken(opsCtx(ctx), async (token) => {
      client = clientFor(token);
      const c = client;
      // 1. The live price, against the one the person saw.
      await checkpoint("price");
      const live = await livePrice(c, input.serverType, input.location);
      if (live === null) throw noPrice();
      if (!live.available) throw new HetznerError("resource_unavailable", "not available there");
      const q = input.quoted;
      if (q.currency !== live.currency || !sameMoney(q.hourly_gross, live.hourly_gross) || !sameMoney(q.monthly_gross, live.monthly_gross) || !sameMoney(q.ipv4_monthly_gross, live.ipv4_monthly_gross)) {
        throw new ApiError(409, "price_changed", "The price changed. Check the new price and confirm again", undefined, {
          live: { currency: live.currency, hourly_gross: live.hourly_gross, monthly_gross: live.monthly_gross, ipv4_monthly_gross: live.ipv4_monthly_gross },
        });
      }
      // 2. The firewall: no inbound rule, except SSH when a key was given.
      await checkpoint("firewall");
      const fw = await c.createFirewall({
        name: `fx-${serverId}`, labels: { [MANAGED_LABEL]: MANAGED_LABEL_VALUE, "fx-server": serverId },
        rules: input.sshKeyId === undefined ? [] : [{ direction: "in", protocol: "tcp", port: "22", sourceIps: ["0.0.0.0/0", "::/0"], description: "SSH" }],
      });
      made.firewallId = fw.id;
      // 3. The single-use token, then the user_data that carries it.
      await checkpoint("token");
      const issued = await mintServerProvisioningToken(deps, ctx.principal, "subscription");
      made.tokenId = issued.id;
      await checkpoint("render");
      const userData = renderUserData({ origin, credentialMode: "subscription", token: issued });
      // 4. The row, with the price stamped (its price columns cannot be changed afterwards). It exists before the server so the server's label names it.
      await checkpoint("insert");
      await withTenant(ctx.pool, accountId, userId, (cl) =>
        cl.query(
          `INSERT INTO managed_servers (id, account_id, kind, credential_id, name, server_type, location, status, price_hourly_gross, price_monthly_gross, ipv4_monthly_gross, currency, provisioning_token_id, created_by, idempotency_key)
           VALUES ($1, $2, 'hetzner_cloud', (SELECT id FROM machine_provider_credentials WHERE account_id = $2 AND provider = 'hetzner_cloud' AND removed_at IS NULL), $3, $4, $5, 'creating', $6, $7, $8, $9, $10, $11, $12)`,
          [serverId, accountId, name, input.serverType, input.location, live.hourly_gross, live.monthly_gross, live.ipv4_monthly_gross, live.currency, issued.id, userId, input.idempotencyKey],
        ),
      );
      made.serverRowId = serverId;
      // 5. The server: IPv4 only (see the header), labelled with the row's id, and named by the create key so a retry finds it instead of making a second.
      await checkpoint("server");
      made.serverSent = true;
      const created = await c.createServer({
        name, serverType: input.serverType, location: input.location, image: SERVER_IMAGE, userData, firewalls: [fw.id],
        ...(input.sshKeyId === undefined ? {} : { sshKeys: [input.sshKeyId] }),
        labels: { [MANAGED_LABEL]: MANAGED_LABEL_VALUE, "fx-server": serverId }, publicNet: { enableIpv4: true, enableIpv6: false }, idempotencyKey: serverId,
      });
      made.hetznerServerId = created.server.id;
      const actionId = created.action?.id;
      // 6. The IP the token is bound to, and the audit row, together: either both are there or neither is and the whole create is undone.
      await checkpoint("finalize");
      const row = await withTenant(ctx.pool, accountId, userId, async (cl) => {
        const { rows } = await cl.query<Row>(
          `UPDATE managed_servers SET provider_server_id = $3, provider_firewall_id = $4, public_ipv4 = $5::inet, create_action_id = $6, status_at = now()
            WHERE account_id = $1 AND id = $2 AND status = 'creating' RETURNING ${COLUMNS}`,
          [accountId, serverId, String(created.server.id), String(fw.id), created.server.ipv4, actionId === undefined ? null : String(actionId)],
        );
        // A delete that got in first has made the row `deleted`: the server just made must not live on under it, so this throws and the whole create is undone.
        if (!rows[0]) throw new Error("the server's row is gone or is no longer being created");
        await checkpoint("audit");
        await cl.query("SELECT audit_write('server.create_confirmed', $1::jsonb)", [JSON.stringify({ server_id: serverId, server_type: input.serverType, location: input.location })]);
        return rows[0];
      });
      return { server: viewOf(row), reused: false };
    }).then(async (out) => {
      // The queued status worker follows the row to ready or failed. A start that is refused does not undo a server that now exists and is billed: it is reported, and the person's Delete still works.
      try { await machineServerDeps.startStatusWorker?.({ accountId, userId, serverId: out.server.id }); } catch (e) { reportError(e, { stage: "machine_server.start_status_worker", route: "/api/v1/machine-servers" }); }
      return out;
    });
  } catch (e) {
    const raced = isUniqueKey(e);
    if (client !== undefined) await unwind(ctx, client, deps, serverId, raced ? { ...made, serverRowId: undefined } : made, failureCodeOf(e), e);
    if (raced) {
      const again = await withTenant(ctx.pool, accountId, userId, async (c) => (await c.query<Row>(`SELECT ${COLUMNS} FROM managed_servers WHERE account_id = $1 AND idempotency_key = $2`, [accountId, input.idempotencyKey])).rows[0]);
      if (again) return { server: viewOf(again), reused: true };
    }
    throw toApiError(e);
  }
}

/** The unique index on (account, key) refused the insert: another request with the same key got there first. */
const isUniqueKey = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505" && /managed_servers_idempotency_key/.test(String((e as { constraint?: unknown }).constraint ?? ""));
