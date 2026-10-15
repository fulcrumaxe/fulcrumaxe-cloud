import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

export const ORIGIN = "https://ops.example.test";
export const OPS_SECRET = "ops-session-secret-for-tests-0123456789abcdef";

/** The settings the console needs, in the process environment of this test worker. Returns a function that restores it. */
export function useOpsEnv(extra: Record<string, string | undefined> = {}): () => void {
  const wanted: Record<string, string | undefined> = {
    FX_OPS_ORIGIN: ORIGIN,
    FX_OPS_SESSION_SECRET: OPS_SECRET,
    DATABASE_URL_OPS_CONSOLE: process.env.TEST_OPS_CONSOLE_URL,
    ...extra,
  };
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(wanted)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

export interface Req {
  method?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  json?: unknown;
}

/** A request as the console would receive it; JSON bodies get the JSON content type and the console's own Origin. */
export function req(path: string, o: Req = {}): NextRequest {
  const headers = new Headers(o.headers);
  // Each request comes from its own address unless the test names one, so the per-address limits on /api/auth/* do not couple unrelated tests.
  if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", `test-${randomUUID()}`);
  if (o.json !== undefined) {
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (!headers.has("origin")) headers.set("origin", ORIGIN);
  }
  if (o.cookies) headers.set("cookie", Object.entries(o.cookies).map(([k, v]) => `${k}=${v}`).join("; "));
  const method = o.method ?? (o.json !== undefined ? "POST" : "GET");
  return new NextRequest(new URL(path, ORIGIN), { method, headers, ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : {}) });
}
