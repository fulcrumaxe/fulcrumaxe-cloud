import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveStatic, type StaticServer } from "../../src/lib/browser/serve.js";

let tmp: string;
let server: StaticServer;
const get = (p: string, init?: RequestInit) => fetch(server.origin + p, init);

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fx-serve-"));
  const root = path.join(tmp, "root");
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.mkdir(path.join(root, "empty"));
  await fs.writeFile(path.join(root, "index.html"), "<h1>home</h1>");
  await fs.writeFile(path.join(root, "docs", "index.html"), "<h1>docs</h1>");
  await fs.writeFile(path.join(root, "data.json"), "{}");
  await fs.writeFile(path.join(tmp, "sentinel"), "SECRET");
  await fs.symlink(path.join(tmp, "sentinel"), path.join(root, "link"));
  server = await serveStatic(root, {
    headers: [{ source: "/(.*)", headers: [{ key: "X-Test", value: "yes" }] }],
  });
});

afterAll(async () => {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("serveStatic", () => {
  it("listens on 127.0.0.1 with an ephemeral port", () => {
    expect(server.address).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);
  });

  it("serves GET and HEAD only", async () => {
    expect((await get("/")).status).toBe(200);
    expect((await get("/", { method: "HEAD" })).status).toBe(200);
    expect((await get("/", { method: "POST", body: "x" })).status).toBe(405);
  });

  it.each(["/..%2fsentinel", "/..%2f..%2fsentinel", "/%2e%2e/sentinel", "/..%5csentinel", "/index.html%00", "/link"])(
    "never serves a file outside root: %s",
    async (p) => {
      const res = await get(p);
      expect([400, 404]).toContain(res.status);
      expect(await res.text()).not.toContain("SECRET");
    },
  );

  it("serves a directory's index.html, 404s a directory without one, lists nothing", async () => {
    expect(await (await get("/docs")).text()).toContain("docs");
    const empty = await get("/empty");
    expect(empty.status).toBe(404);
    expect(await empty.text()).not.toContain("index");
  });

  it("runs no handler: /api/x is 404 unless a static file exists", async () => {
    expect((await get("/api/x")).status).toBe(404);
  });

  it("applies the headers option", async () => {
    expect((await get("/data.json")).headers.get("x-test")).toBe("yes");
  });

  it("refuses connections after close()", async () => {
    const s = await serveStatic(tmp);
    const { port } = s;
    await s.close();
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      net.connect(port, "127.0.0.1").on("error", resolve);
    });
    expect(err.code).toBe("ECONNREFUSED");
  });
});
