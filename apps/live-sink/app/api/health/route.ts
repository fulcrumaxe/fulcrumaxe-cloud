export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Answers without touching the store or any setting, so it can never show a secret. */
export function GET(): Response {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
