import type { Pool } from "pg";
import { createPool } from "@fx/db/src/pool";
import { FakeProviderStateFull, withFakeProviderState } from "@fx/db/src/fakeProviderState";
import { emptyFakeState, fakeAuthOk, fakeProviderAllowed, handleFake, type FakeReply, type FakeState } from "@fx/hetzner";

/**
 * D#845 MC-13a: /api/_fake/hetzner/v1/* serves the staging Hetzner fake (packages/hetzner/src/fake.ts) so the real client, real TLS and real parse run end to end.
 * The folder is `%5Ffake` because Next treats a folder that starts with `_` as private and routes nothing under it.
 *
 * Gate: it answers only when FX_MACHINE_PROVIDER_FAKE=1 and FX_DEPLOY_KIND is staging; otherwise it is a plain 404 (the same body as any unknown API path), so
 * production shows nothing. State is one row in `fake_provider_state` (platform_ops only), changed under a row lock. A bearer token is required; the token is never
 * stored, logged or echoed (this file reads the Authorization header once and hands it to the fake, which only tests its shape).
 */
/** A request body larger than this is refused before it is read in full or parsed. */
export const MAX_BODY_BYTES = 64 * 1024;

export interface FakeRouteDeps {
  env: Readonly<Record<string, string | undefined>>;
  run: <T>(fn: (state: FakeState) => T) => Promise<T>;
}

let pool: Pool | undefined;
const defaultDeps = (): FakeRouteDeps => ({
  env: process.env,
  run: (fn) => {
    const url = process.env.DATABASE_URL_PLATFORM_OPS;
    if (!url) throw new Error("fake provider: no platform_ops login");
    pool ??= createPool(url);
    return withFakeProviderState(pool, "hetzner", emptyFakeState, fn);
  },
});

const json = (r: FakeReply): Response => new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "Cache-Control": "no-store", ...(r.body === undefined ? {} : { "Content-Type": "application/json" }) } });
const tooLarge = (): Response => json({ status: 413, body: { error: { code: "request_entity_too_large", message: "the request body is too large" } } });
const notFound = (): Response => json({ status: 404, body: { error: { code: "not_found", message: "not found" } } });

export async function fakeHetznerHandler(req: Request, deps: FakeRouteDeps = defaultDeps()): Promise<Response> {
  if (!fakeProviderAllowed(deps.env)) return notFound();
  // The bearer is judged before anything opens the store, so an unauthenticated caller costs no connection and no row lock.
  const auth = req.headers.get("authorization");
  if (!fakeAuthOk(auth)) return json({ status: 401, body: { error: { code: "unauthorized", message: "unable to authenticate" } } });
  const url = new URL(req.url);
  const at = url.pathname.indexOf("/api/_fake/hetzner/");
  if (at < 0) return notFound();
  const target = new URL(url.pathname.slice(at + "/api/_fake/hetzner".length) + url.search, "https://fake.invalid");
  let body: Record<string, unknown> = {};
  if (req.method === "POST" || req.method === "PUT") {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return tooLarge();
    try {
      if (!/^application\/json/i.test(req.headers.get("content-type") ?? "")) throw new Error("content type");
      const text = await req.text();
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) return tooLarge();
      const parsed: unknown = JSON.parse(text || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
      body = parsed as Record<string, unknown>;
    } catch {
      // fx-swallow-ok: Hetzner's own answer to an unreadable body; nothing about the body is kept
      return json({ status: 400, body: { error: { code: "json_error", message: "invalid JSON input" } } });
    }
  }
  try {
    return json(await deps.run((state) => handleFake(state, req.method, target, body, auth)));
  } catch (e) {
    // The stored document is at its size limit: a write that would grow it is refused the way Hetzner refuses a full project. Reads and deletes still work.
    if (e instanceof FakeProviderStateFull) return json({ status: 403, body: { error: { code: "resource_limit_exceeded", message: "the fake provider is full; delete something first" } } });
    // fx-swallow-ok: the fake's store is down; the caller sees Hetzner's own server_error shape and never the cause
    return json({ status: 500, body: { error: { code: "server_error", message: "the fake provider is unavailable" } } });
  }
}
