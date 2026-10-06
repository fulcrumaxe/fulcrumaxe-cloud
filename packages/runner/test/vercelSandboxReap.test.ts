import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVercelSandboxPort } from "../src/vercelSandboxPort.js";
import type { ListedSandbox, SandboxPort } from "../src/sandboxPort.js";
import { createFakeSandbox } from "../src/fakeSandbox.js";
import { createStubRuntime } from "./helpers/stubRuntime.js";
import { createReaperSdkFake } from "./helpers/reaperSdkFake.js";

/** D#2 SANDBOX-REAPER-1a, C81 criteria 1-3: the port's list, its snapshot delete, and the fake that stands for the provider. */
const EX = (n: number) => `ex-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222-${n}`;
const RN = (n: number) => `rn-8-reviewer-00000000-0000-4000-8000-00000000000${n}`;

function portOver(fake: ReturnType<typeof createReaperSdkFake>): SandboxPort {
  return createVercelSandboxPort({ teamId: "team_1", projectId: "prj_1", getToken: async () => "tok", sdk: fake.sdk });
}

async function listAll(port: SandboxPort, prefix: "ex-" | "rn-"): Promise<ListedSandbox[]> {
  const out: ListedSandbox[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await port.listSandboxes!({ prefix, ...(cursor !== undefined && { cursor }) });
    out.push(...page.sandboxes);
    if (page.next === null) return out;
    cursor = page.next;
  }
  throw new Error("list did not end");
}

describe("criterion 1: listSandboxes", () => {
  it("accepts only the ex- and rn- prefixes: anything else rejects before a request is made", async () => {
    const fake = createReaperSdkFake();
    fake.seed("rlr0-spike-1");
    fake.seed(EX(1));
    const port = portOver(fake);
    for (const prefix of ["", "e", "ex", "EX-", "rlr0-", "rn", "ex-1", " ex-"]) {
      await expect(port.listSandboxes!({ prefix: prefix as "ex-" }), JSON.stringify(prefix)).rejects.toThrow(/only "ex-" and "rn-"/);
    }
    await expect(port.listSandboxes!(undefined as never)).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });

  it("pages through a two-page list completely, returns plain fields, and filters by prefix on the server", async () => {
    const fake = createReaperSdkFake();
    fake.pageLimit = 2;
    for (const n of [1, 2, 3]) fake.seed(EX(n), n === 2 ? "running" : "stopped");
    fake.seed(RN(1), "failed", { persistent: false });
    fake.seed("rlr0-spike-1");
    const port = portOver(fake);
    const ex = await listAll(port, "ex-");
    expect(ex.map((s) => s.name)).toEqual([EX(1), EX(2), EX(3)]);
    expect(ex.map((s) => s.status)).toEqual(["stopped", "running", "stopped"]);
    expect(ex[0]).toEqual({ name: EX(1), persistent: true, status: "stopped", createdAt: expect.any(Number), updatedAt: expect.any(Number) });
    expect(fake.listQueries.map((q) => [q.namePrefix, q.cursor])).toEqual([["ex-", undefined], ["ex-", "2"]]);
    expect((await listAll(port, "rn-")).map((s) => [s.name, s.persistent, s.status])).toEqual([[RN(1), false, "failed"]]);
  });

  it("a 429 or 5xx surfaces as SandboxPortError with the status; a doubt never becomes an empty list", async () => {
    const fake = createReaperSdkFake();
    fake.seed(EX(1));
    const port = portOver(fake);
    for (const status of [429, 500, 503]) {
      fake.failNext("list", status);
      await expect(port.listSandboxes!({ prefix: "ex-" })).rejects.toMatchObject({ name: "SandboxPortError", operation: "listSandboxes", status });
    }
  });

  it("the fake SandboxPort pages, filters and fails the same way", async () => {
    const f = createFakeSandbox(createStubRuntime());
    f.setListPageSize(2);
    for (const n of [1, 2, 3]) f.seedProviderSandbox(EX(n));
    f.seedProviderSandbox(RN(1), { status: "running" });
    f.seedProviderSandbox("rlr0-spike-1");
    expect([(await listAll(f.port, "ex-")).map((s) => s.name), (await listAll(f.port, "rn-")).map((s) => s.name)]).toEqual([[EX(1), EX(2), EX(3)], [RN(1)]]);
    f.failList(429);
    await expect(f.port.listSandboxes!({ prefix: "ex-" })).rejects.toMatchObject({ status: 429 });
  });
});

describe("criterion 2: the reads never wake a sandbox", () => {
  it("sandboxState on a stopped sandbox opens it without resume and runs nothing; listing touches no sandbox", async () => {
    const fake = createReaperSdkFake();
    fake.seed(EX(1), "stopped");
    fake.seed(EX(2), "running");
    const port = portOver(fake);
    await expect(port.sandboxState!({ runId: "r", sandboxName: EX(1) })).resolves.toBe("stopped");
    await expect(port.sandboxState!({ runId: "r", sandboxName: EX(2) })).resolves.toBe("running");
    await expect(port.sandboxState!({ runId: "r", sandboxName: EX(3) })).resolves.toBe("gone");
    await listAll(port, "ex-");
    expect(fake.calls.filter((c) => c.startsWith("get:"))).toEqual([`get:${EX(1)}:resume=false`, `get:${EX(2)}:resume=false`, `get:${EX(3)}:resume=false`]);
    expect(fake.waking).toEqual([]);
  });
});

describe("criterion 3: delete with snapshots", () => {
  it("with no option the snapshot stays; with deleteSnapshots it goes; a second delete answers 404 and counts as success", async () => {
    const fake = createReaperSdkFake();
    fake.seed(EX(1));
    fake.seed(EX(2));
    const port = portOver(fake);
    await port.deleteSandbox({ runId: "r", sandboxName: EX(1) }, { deleteSnapshots: false });
    expect(fake.snapshots.has(EX(1))).toBe(true);
    await port.deleteSandbox({ runId: "r", sandboxName: EX(2) }, { deleteSnapshots: true });
    expect(fake.snapshots.has(EX(2))).toBe(false);
    expect(fake.estate.size).toBe(0);
    await expect(port.deleteSandbox({ runId: "r", sandboxName: EX(2) }, { deleteSnapshots: true })).resolves.toBeUndefined();
  });

  it("the fake SandboxPort: without the flag the snapshot stays listed, with it the snapshot goes, and a second delete does not throw", async () => {
    const f = createFakeSandbox(createStubRuntime());
    f.seedProviderSandbox(EX(1), { snapshot: true });
    f.seedProviderSandbox(EX(2), { snapshot: true });
    await f.port.deleteSandbox({ runId: "r", sandboxName: EX(1) });
    expect(f.state.snapshots).toEqual([EX(1), EX(2)]);
    await f.port.deleteSandbox({ runId: "r", sandboxName: EX(2) }, { deleteSnapshots: true });
    expect(f.state.snapshots).toEqual([EX(1)]);
    await expect(f.port.deleteSandbox({ runId: "r", sandboxName: EX(2) }, { deleteSnapshots: true })).resolves.toBeUndefined();
    expect((await listAll(f.port, "ex-")).map((s) => s.name)).toEqual([]);
  });
});

describe("through Node's real connection path: the real SDK against a local server", () => {
  const requests: Array<{ method: string; path: string; query: Record<string, string>; auth: string | undefined; userAgent: string | undefined }> = [];
  let server: Server;
  let origin = "";
  const sandbox = (name: string, status = "stopped") => ({ name, persistent: true, status, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_001, currentSessionId: "sess_1" });
  const session = { id: "sess_1", memory: 4096, vcpus: 2, region: "iad1", timeout: 3_600_000, status: "stopped", requestedAt: 1, createdAt: 1, cwd: "/vercel/sandbox", updatedAt: 2 };
  const readHeader = (req: IncomingMessage, name: string) => (Array.isArray(req.headers[name]) ? req.headers[name]![0] : req.headers[name]);

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://local");
      url.pathname = url.pathname.replace(/^\/api(?=\/v2\/)/, ""); // the SDK's base URL is https://vercel.com/api
      requests.push({ method: req.method ?? "", path: url.pathname, query: Object.fromEntries(url.searchParams), auth: readHeader(req, "authorization"), userAgent: readHeader(req, "user-agent") });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && url.pathname === "/v2/sandboxes") {
        const cursor = url.searchParams.get("cursor");
        const body = cursor === null
          ? { sandboxes: [sandbox(EX(1)), sandbox(EX(2), "running")], pagination: { count: 2, next: "c2" } }
          : { sandboxes: [sandbox(EX(3))], pagination: { count: 1, next: null } };
        res.end(JSON.stringify(body));
      } else if (req.method === "GET" && url.pathname.startsWith("/v2/sandboxes/")) {
        res.end(JSON.stringify({ sandbox: sandbox(decodeURIComponent(url.pathname.split("/").pop()!)), session, routes: [] }));
      } else if (req.method === "DELETE" && url.pathname.startsWith("/v2/sandboxes/")) {
        res.end(JSON.stringify({ sandbox: sandbox(decodeURIComponent(url.pathname.split("/").pop()!)) }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: "not_found", message: "no" } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** The SDK builds https://vercel.com/api URLs; this fetch sends them to the local server over a real socket. */
  const toLocal: typeof globalThis.fetch = (input, init) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    expect(target.origin).toBe("https://vercel.com");
    return fetch(`${origin}${target.pathname}${target.search}`, init);
  };
  const port = () => createVercelSandboxPort({ teamId: "team_9", projectId: "prj_9", getToken: async () => "secret-token", fetch: toLocal });

  it("list sends the project, the name prefix and the cursor, with the bearer token and a User-Agent, and pages to the end", async () => {
    requests.length = 0;
    const all = await listAll(port(), "ex-");
    expect(all.map((s) => [s.name, s.status])).toEqual([[EX(1), "stopped"], [EX(2), "running"], [EX(3), "stopped"]]);
    expect(requests.map((r) => [r.method, r.path])).toEqual([["GET", "/v2/sandboxes"], ["GET", "/v2/sandboxes"]]);
    expect(requests[0]!.query).toMatchObject({ teamId: "team_9", project: "prj_9", namePrefix: "ex-" });
    expect(requests[0]!.query.cursor).toBeUndefined();
    expect(requests[1]!.query).toMatchObject({ project: "prj_9", namePrefix: "ex-", cursor: "c2" });
    for (const r of requests) {
      expect(r.auth).toBe("Bearer secret-token");
      expect(r.userAgent).toMatch(/vercel\/sandbox/);
    }
  });

  it("delete asks for the snapshots only when told to, and the state read never resumes", async () => {
    requests.length = 0;
    const p = port();
    await expect(p.sandboxState!({ runId: "r", sandboxName: EX(1) })).resolves.toBe("stopped");
    await p.deleteSandbox({ runId: "r", sandboxName: EX(1) });
    await p.deleteSandbox({ runId: "r", sandboxName: EX(2) }, { deleteSnapshots: true });
    const gets = requests.filter((r) => r.method === "GET");
    const deletes = requests.filter((r) => r.method === "DELETE");
    expect(gets.map((r) => r.query.resume)).toEqual(["false", "false", "false"]);
    expect(deletes.map((r) => [r.path, r.query.deleteOrphanSnapshots])).toEqual([[`/v2/sandboxes/${EX(1)}`, undefined], [`/v2/sandboxes/${EX(2)}`, "true"]]);
    for (const r of deletes) expect(r.query.projectId).toBe("prj_9");
  });
});
