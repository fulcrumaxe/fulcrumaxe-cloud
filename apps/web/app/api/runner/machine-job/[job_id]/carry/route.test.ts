import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { stateCarryBeginPath, stateCarryChunkPath, stateCarryFailPath, stateCarryImportedPath, stateCarrySealPath } from "@fulcrumaxe/runner-protocol";
import { CARRY_CHUNK_BODY_BYTES, MAX_BODY_BYTES } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../../lib/runnerRoutes";
import * as begin from "./begin/route";
import * as chunk from "./chunk/[index]/route";
import * as fail from "./fail/route";
import * as imported from "./imported/route";
import * as seal from "./seal/route";

const ORIGIN = "https://runner.example.test";
const JOB = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";

/**
 * D#845 MC-9b2: the edge of the state carry's five runner routes. The decisions (the definers, the sealing, the single take) are in packages/runner-cloud with a pg suite; what is pinned here is that each route is wired
 * to the runner door and nothing else (a signature, no session), takes only its own methods, and has the right body cap: 4 MiB for the chunk upload and 256 KiB everywhere else.
 */
describe("the state carry routes", () => {
  const KEYS = ["DATABASE_URL_PLATFORM_OPS", "DATABASE_URL_APP_USER", "FX_APP_ORIGIN"] as const;
  const saved = KEYS.map((key) => [key, process.env[key]] as const);
  beforeAll(() => {
    // Pools connect lazily; none of these requests reaches a query.
    process.env.DATABASE_URL_PLATFORM_OPS = "postgres://unused:unused@127.0.0.1:1/unused";
    process.env.DATABASE_URL_APP_USER = "postgres://unused:unused@127.0.0.1:1/unused";
    process.env.FX_APP_ORIGIN = ORIGIN;
  });
  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const req = (path: string, method: string, payload?: Blob | string, headers: Record<string, string> = {}) =>
    new NextRequest(`${ORIGIN}${path}`, { method, headers: { ...headers }, ...(payload === undefined ? {} : { body: payload }) });
  const ctx = { params: Promise.resolve({ job_id: JOB, index: "0" }) };
  const postRoutes = [
    ["begin", begin, stateCarryBeginPath(JOB)],
    ["seal", seal, stateCarrySealPath(JOB)],
    ["fail", fail, stateCarryFailPath(JOB)],
    ["imported", imported, stateCarryImportedPath(JOB)],
  ] as const;

  it("exports the methods each route takes and no other, on the node runtime, never cached", () => {
    for (const [name, route] of postRoutes) {
      expect(Object.keys(route).sort(), name).toEqual(["POST", "dynamic", "runtime"]);
      expect(route.runtime).toBe("nodejs");
      expect(route.dynamic).toBe("force-dynamic");
    }
    expect(Object.keys(chunk).sort()).toEqual(["GET", "PUT", "dynamic", "runtime"]);
    expect(chunk.runtime).toBe("nodejs");
    expect(chunk.dynamic).toBe("force-dynamic");
  });

  it("answers an unsigned request 401 without a query, even with a session cookie or a bearer token", async () => {
    for (const [name, route, path] of postRoutes) {
      expect((await route.POST(req(path, "POST", "{}"), ctx)).status, name).toBe(401);
      const res = await route.POST(req(path, "POST", "{}", { cookie: "fx_session=abc", authorization: "Bearer fxat_notarealtoken" }), ctx);
      expect(res.status, name).toBe(401);
      expect(JSON.stringify(await res.json())).not.toMatch(/eyJ/);
    }
    expect((await chunk.PUT(req(stateCarryChunkPath(JOB, 0), "PUT", Buffer.from("x") as unknown as string), ctx)).status).toBe(401);
    expect((await chunk.GET(req(stateCarryChunkPath(JOB, 0), "GET"), ctx)).status).toBe(401);
  });

  it("holds the body cap per route: 256 KiB + 1 is 413 on every route but the chunk upload, which takes 4 MiB and answers 413 at 4 MiB + 1", async () => {
    expect(CARRY_CHUNK_BODY_BYTES).toBe(4 * 1024 * 1024);
    for (const [name, route, path] of postRoutes) {
      expect((await route.POST(req(path, "POST", new Blob([Buffer.alloc(MAX_BODY_BYTES + 1)])), ctx)).status, name).toBe(413);
      expect((await route.POST(req(path, "POST", new Blob([Buffer.alloc(MAX_BODY_BYTES)])), ctx)).status, name).toBe(401);
    }
    const path = stateCarryChunkPath(JOB, 0);
    expect((await chunk.PUT(req(path, "PUT", new Blob([Buffer.alloc(MAX_BODY_BYTES + 1)])), ctx)).status).toBe(401);
    expect((await chunk.PUT(req(path, "PUT", new Blob([Buffer.alloc(CARRY_CHUNK_BODY_BYTES)])), ctx)).status).toBe(401);
    expect((await chunk.PUT(req(path, "PUT", new Blob([Buffer.alloc(CARRY_CHUNK_BODY_BYTES + 1)])), ctx)).status).toBe(413);
    expect((await chunk.GET(req(path, "GET", undefined, { "content-length": String(MAX_BODY_BYTES + 1) }), ctx)).status).toBe(413);
  });

  it("sends a chunk as raw bytes: application/octet-stream, no store, the bytes exactly", async () => {
    const bytes = Uint8Array.from([0, 255, 128, 10, 13]);
    const res = await handleRunnerRequest(req("/x", "GET"), async () => ({ status: 200, body: null, binary: bytes, headers: { "x-fx-chunk-sha256": "a".repeat(64) } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-fx-chunk-sha256")).toBe("a".repeat(64));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });
});
