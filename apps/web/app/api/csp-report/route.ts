import { NextRequest, NextResponse } from "next/server";
import { applySecurityHeaders } from "../../../lib/shell/headers";

/**
 * D#37 WS-C criterion 13: "`Reporting-Endpoints: csp="/api/csp-report"`
 * served by `apps/web/app/api/csp-report/route.ts` (accepts
 * `application/reports+json` up to 16 KB, logs one structured line,
 * stores nothing; exempt from the JSON content-type rule, not from the
 * origin rule)." The content-type exemption itself lives in
 * `lib/shell/csrf.ts` (this route can't grant its own exemption --
 * CSRF classification runs in middleware, before any route is reached).
 *
 * "Stores nothing": this deliberately never writes to any table --
 * a CSP violation report is operational noise (a misconfigured policy,
 * a browser extension injecting a script), not tenant data, and giving
 * it a database row would need its own retention/access-control story
 * for no benefit WS-C1 needs. One structured console line is enough to
 * catch a real policy regression (D#37 WS-C criterion 13's own
 * acceptance check: "signing in and opening Themes produces zero CSP
 * violation reports" -- a non-zero count here during that Playwright
 * run is exactly the signal that check exists to catch).
 *
 * Security fix round item 6 (CWE-400, Uncontrolled Resource
 * Consumption): a prior version read the whole body via `req.text()`
 * before ever checking its size when `Content-Length` was missing or
 * understated, and measured the result with `.length` (UTF-16 code
 * units, not bytes -- undercounts for any multi-byte UTF-8 character).
 * `readBodyWithByteLimit` below enforces the real limit against actual
 * bytes read AS they're read, never buffering past it regardless of
 * what `Content-Length` claims. The route also now only accepts the two
 * media types criterion 13 actually names.
 */
const MAX_BODY_BYTES = 16 * 1024;

const ACCEPTED_CONTENT_TYPES = new Set(["application/csp-report", "application/reports+json"]);

function contentTypeAccepted(req: NextRequest): boolean {
  const raw = req.headers.get("content-type") ?? "";
  const base = raw.split(";")[0]!.trim().toLowerCase();
  return ACCEPTED_CONTENT_TYPES.has(base);
}

/**
 * Reads `req`'s body up to `limit` BYTES, aborting the moment the
 * running total crosses it rather than buffering the whole body first
 * and checking after. Returns null when the limit was exceeded (the
 * caller answers 413), or the exact bytes read otherwise. A missing or
 * understated `Content-Length` does not bypass this -- it is the
 * authoritative check, independent of what that header claims.
 */
async function readBodyWithByteLimit(req: NextRequest, limit: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!contentTypeAccepted(req)) {
    return applySecurityHeaders(NextResponse.json({ error: "unsupported_media_type" }, { status: 415 }));
  }

  // A declared Content-Length over the limit is rejected immediately
  // without reading any body -- a cheap fast path, not the real check:
  // readBodyWithByteLimit below enforces the limit against actual bytes
  // regardless of what this header says (it can be absent or lie low).
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return applySecurityHeaders(NextResponse.json({ error: "payload_too_large" }, { status: 413 }));
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyWithByteLimit(req, MAX_BODY_BYTES);
  } catch {
    bytes = new Uint8Array(0);
  }
  if (bytes === null) {
    return applySecurityHeaders(NextResponse.json({ error: "payload_too_large" }, { status: 413 }));
  }

  let report: unknown = null;
  try {
    const text = new TextDecoder().decode(bytes);
    report = text ? JSON.parse(text) : null;
  } catch {
    // A malformed report body is still just a report -- log what we can
    // (nothing parsed) and answer 204 either way; this endpoint's whole
    // job is to never be the reason a real page load fails.
  }

  // One structured line, no PII beyond what the browser itself chose to
  // report (URLs the page's own CSP already scoped to 'self'/named
  // origins). Never written to any table -- see the file header.
  console.log(JSON.stringify({ event: "csp_report", report }));

  return applySecurityHeaders(new NextResponse(null, { status: 204 }));
}
