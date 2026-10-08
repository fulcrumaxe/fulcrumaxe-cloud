import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A strict stand-in for `GET /v1/report`: a real HTTP server on 127.0.0.1 that the client reaches through Node's own
 * connection path. It enforces what the real service does that our client touches: the date format, the group_by
 * values, the tag length, `api_key_id=self` needing a `vck_` key, 401/403 by key, only the grouping field plus metrics,
 * a non-zero `gateway_cost` decoy, ingestion delay, and rows for tags that were not asked for (a merged tag union).
 */
export interface FakeRow {
  total_cost: number;
  surcharge_cost: number;
  request_count: number;
}

export interface FakeReport {
  url: string;
  /** Rows to answer per tag, one entry per read in order; the last repeats. Missing = no row yet. */
  script: Map<string, FakeRow[]>;
  /** Tags the VM "added itself": returned whenever asked for, never requested by us. */
  strangerTags: string[];
  notEntitled: Set<string>;
  validKeys: Set<string>;
  requests: { search: URLSearchParams; auth: string | undefined }[];
  respondWith?: number;
  /** Answer every request with a 302 to this URL. */
  redirectTo?: string;
  close(): Promise<void>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function startGatewayReportFake(): Promise<FakeReport> {
  const fake = { script: new Map(), strangerTags: [], notEntitled: new Set(), validKeys: new Set(), requests: [] } as unknown as FakeReport;
  const reads = new Map<string, number>();
  const bad = (res: ServerResponse, message: string): void => {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const auth = req.headers.authorization;
    fake.requests.push({ search: u.searchParams, auth });
    if (fake.redirectTo !== undefined) return void res.writeHead(302, { location: fake.redirectTo }).end();
    if (fake.respondWith !== undefined) return void res.writeHead(fake.respondWith).end();
    const key = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (u.pathname !== "/v1/report") return void res.writeHead(404).end();
    if (!fake.validKeys.has(key)) return void res.writeHead(401).end();
    if (fake.notEntitled.has(key)) return void res.writeHead(403).end();
    const q = u.searchParams;
    const start = q.get("start_date");
    const end = q.get("end_date");
    if (!start || !end || !DAY.test(start) || !DAY.test(end) || start > end) return bad(res, "start_date and end_date must be YYYY-MM-DD with start <= end");
    if (q.get("group_by") !== "tag") return bad(res, "unknown group_by");
    const tags = (q.get("tags") ?? "").split(",");
    if (tags.some((t) => t.length < 1 || t.length > 64)) return bad(res, "a tag must be 1 to 64 characters");
    if (q.get("api_key_id") === "self" && !key.startsWith("vck_")) return bad(res, "api_key_id=self needs a vck_ key");
    const results: unknown[] = [];
    for (const tag of [...tags, ...fake.strangerTags]) {
      const rows = fake.script.get(tag);
      const n = reads.get(tag) ?? 0;
      if (tags.includes(tag)) reads.set(tag, n + 1);
      const row = rows?.[Math.min(n, (rows?.length ?? 1) - 1)];
      if (row) results.push({ tag, ...row, gateway_cost: row.total_cost * 7 + 1 });
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}
