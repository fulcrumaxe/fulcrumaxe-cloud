import { ID_PATTERN, MAX_BODY_BYTES, getStore } from "../../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reply = (status: number, body: object): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The body as text, or null when it is over the limit. Counts bytes as they arrive, so a chunked body cannot slip past. */
async function readCapped(req: Request): Promise<string | null> {
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Nothing in this file logs a body, a header or an id.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!ID_PATTERN.test(id)) return reply(404, { error: "not_found" });
  const body = await readCapped(req);
  if (body === null) return reply(413, { error: "too_large" });
  const store = getStore();
  if (!store) return reply(503, { error: "unavailable" });
  try {
    await store.append(id, { body, headers: Object.fromEntries(req.headers), receivedAt: new Date().toISOString() });
  } catch {
    console.error("live-sink: store write failed");
    return reply(503, { error: "unavailable" });
  }
  return reply(200, { ok: true });
}
