import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKER_TTL_SECONDS, markWorkPending, runGatedTick, setPendingHooks } from "@fx/core/src/pendingWork";
import { runtimeCacheStore } from "../lib/pendingWorkStore";

/**
 * D#454 H3c: the production store, through the REAL @vercel/functions Runtime Cache client and Node's real HTTP path,
 * against a local server that speaks the cache endpoint's protocol the way the client uses it:
 *   GET  <endpoint><key>  404 = miss; 200 with `x-vercel-cache-state: fresh` + JSON body = hit; anything else, or a
 *                         stale/expired state, is read by the client as a miss (it never throws)
 *   POST <endpoint><key>  body = JSON value, `x-vercel-revalidate` = TTL seconds
 *   DELETE <endpoint><key>
 * What this cannot reproduce, and the PR says so: the real endpoint's TLS and auth, its regional replication delay,
 * and its eviction policy. Regions are modelled by switching which entry table the server answers from.
 */
type Entry = { body: string; ttlSeconds: number; storedAt: number };
const regions = new Map<string, Map<string, Entry>>();
let region = "iad1";
let mode: "ok" | "error" | "hang" = "ok";
const seen: Array<{ method: string; path: string; revalidate: string | undefined; auth: string | undefined; name: string | undefined }> = [];
let server: Server;

function table(): Map<string, Entry> {
  if (!regions.has(region)) regions.set(region, new Map());
  return regions.get(region)!;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const path = req.url ?? "";
  seen.push({
    method: req.method ?? "",
    path,
    revalidate: req.headers["x-vercel-revalidate"] as string | undefined,
    auth: req.headers["x-test-auth"] as string | undefined,
    name: req.headers["x-vercel-cache-item-name"] as string | undefined,
  });
  if (req.headers["x-test-auth"] !== "secret") {
    res.writeHead(401).end();
    return;
  }
  const reply = (): void => {
    if (mode === "error") {
      res.writeHead(500).end();
      return;
    }
    if (req.method === "GET") {
      const entry = table().get(path);
      if (!entry) return void res.writeHead(404).end();
      const fresh = Date.now() < entry.storedAt + entry.ttlSeconds * 1000;
      res.writeHead(200, { "x-vercel-cache-state": fresh ? "fresh" : "expired" }).end(entry.body);
    } else if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        table().set(path, { body, ttlSeconds: Number(req.headers["x-vercel-revalidate"] ?? 0), storedAt: Date.now() });
        res.writeHead(200).end();
      });
    } else if (req.method === "DELETE") {
      table().delete(path);
      res.writeHead(200).end();
    } else {
      res.writeHead(405).end();
    }
  };
  if (mode === "hang") setTimeout(reply, 600);
  else reply();
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // The client reads these on its first use and keeps them for the life of the process.
  vi.stubEnv("RUNTIME_CACHE_ENDPOINT", `http://127.0.0.1:${port}/`);
  vi.stubEnv("RUNTIME_CACHE_HEADERS", JSON.stringify({ "x-test-auth": "secret" }));
  vi.stubEnv("RUNTIME_CACHE_TIMEOUT", "150");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  regions.clear();
  region = "iad1";
  mode = "ok";
  seen.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {}); // the client logs the failures it swallows
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  setPendingHooks(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runtimeCacheStore through the real client", () => {
  it("round-trips a number, sends the TTL in seconds and a readable name, and hashes the key under a namespace", async () => {
    const store = runtimeCacheStore();
    await store.set("pending:api-sweep", 1_800_000_000_000, MARKER_TTL_SECONDS);
    expect(await store.get("pending:api-sweep")).toBe(1_800_000_000_000);
    const write = seen.find((s) => s.method === "POST")!;
    expect(write.revalidate).toBe(String(MARKER_TTL_SECONDS));
    expect(write.name).toBe("pending:api-sweep");
    expect(write.path).toMatch(/^\/fx-pending\$[0-9a-f]+$/);
    await store.delete("pending:api-sweep");
    expect(await store.get("pending:api-sweep")).toBeNull();
  });

  it("reads an expired entry, a 500, a refused request and a hung server as a miss, never as an error", async () => {
    const store = runtimeCacheStore();
    await store.set("k", 7, 60);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    expect(await store.get("k")).toBeNull(); // past its TTL: the server says expired
    vi.useRealTimers();

    await store.set("k", 7, 600);
    mode = "error";
    expect(await store.get("k")).toBeNull();
    await expect(store.set("k2", 1, 60)).resolves.toBeUndefined(); // a lost write, no throw
    mode = "hang";
    const started = Date.now();
    expect(await store.get("k")).toBeNull(); // cut off by the client's timeout
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("a marker written in one region is not seen by a tick in another: that tick connects on the backstop and then skips", async () => {
    setPendingHooks({ store: runtimeCacheStore() });
    const run = vi.fn(async () => ({ result: "swept", workFound: true, nextDueAt: null }));
    const tick = () => runGatedTick("api-sweep", run, () => {}, Date.now);

    await tick(); // iad1 connects and records it
    await markWorkPending("api-sweep"); // a writer in iad1
    region = "fra1"; // the cron's tick lands in another region
    run.mockClear();
    await tick();
    expect(run).toHaveBeenCalledTimes(1); // nothing seen there, so the backstop path took it: the work is not lost
    run.mockClear();
    await tick();
    expect(run).not.toHaveBeenCalled(); // and that region now remembers it connected
  });

  it("a full tick over the real client: no marker, no connection; marker, connection", async () => {
    setPendingHooks({ store: runtimeCacheStore() });
    const run = vi.fn(async () => ({ result: "swept", workFound: true, nextDueAt: null }));
    const t0 = Date.now();
    const tick = (at: number) => runGatedTick("run-action-sweep", run, () => {}, () => at);
    await tick(t0);
    run.mockClear();
    await tick(t0 + 60_000);
    expect(run).not.toHaveBeenCalled();
    await markWorkPending("run-action-sweep", { now: t0 + 120_000 });
    await tick(t0 + 300_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
