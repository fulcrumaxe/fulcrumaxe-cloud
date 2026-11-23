import type { Pool } from "pg";

/** The document would grow past the table's size check: nothing is written, and the route answers a clean refusal. Reads and deletes are unaffected. */
export class FakeProviderStateFull extends Error {}

/** D#845 MC-13a: the `fake_provider_state` table (migration 1064), platform_ops only. One JSON document per fake provider, changed under a row lock so two requests never lose each other's write. */
export async function withFakeProviderState<S extends object, T>(pool: Pick<Pool, "connect">, provider: "hetzner", empty: () => S, fn: (state: S) => T): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO fake_provider_state (provider, state) VALUES ($1, $2::jsonb) ON CONFLICT (provider) DO NOTHING", [provider, JSON.stringify(empty())]);
    const { rows } = await client.query<{ state: S }>("SELECT state FROM fake_provider_state WHERE provider = $1 FOR UPDATE", [provider]);
    const state = rows[0]!.state;
    const before = JSON.stringify(state);
    const out = fn(state);
    // A call that changed nothing (every read) writes nothing, so a document at the size limit can still be read and shrunk.
    if (JSON.stringify(state) !== before) await client.query("UPDATE fake_provider_state SET state = $2::jsonb, updated_at = now() WHERE provider = $1", [provider, JSON.stringify(state)]);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined); // fx-swallow-ok: the original error is the one rethrown
    if ((e as { code?: string }).code === "23514") throw new FakeProviderStateFull("fake provider state is at its size limit");
    throw e;
  } finally {
    client.release();
  }
}
