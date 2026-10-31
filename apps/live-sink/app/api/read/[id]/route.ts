import { createHash, timingSafeEqual } from "node:crypto";
import { ID_PATTERN, getStore } from "../../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reply = (status: number, body: object): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** Constant time: both sides are hashed to the same length first, so neither the value nor its length leaks through timing. No token configured means no read. */
function tokenMatches(header: string | null): boolean {
  const expected = process.env.LIVE_SINK_READ_TOKEN;
  if (!expected || !header?.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(expected));
}

// Nothing in this file logs a body, a header, an id or the token.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!tokenMatches(req.headers.get("authorization"))) return reply(401, { error: "unauthorized" });
  const { id } = await ctx.params;
  if (!ID_PATTERN.test(id)) return reply(404, { error: "not_found" });
  const store = getStore();
  if (!store) return reply(503, { error: "unavailable" });
  let deliveries;
  try {
    deliveries = await store.drain(id);
  } catch {
    console.error("live-sink: store read failed");
    return reply(503, { error: "unavailable" });
  }
  return deliveries.length === 0 ? reply(404, { error: "not_found" }) : reply(200, { deliveries });
}
