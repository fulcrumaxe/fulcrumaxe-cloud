import { createServer, request, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBase } from "../../src/verifyBrowser/pin.js";
import { startOriginProxy, type OriginProxy } from "../../src/verifyBrowser/proxy.js";

/**
 * D#749 V2c-2a: the origin proxy, driven with raw requests the way a browser sends them. A strict fake of what a forward proxy must refuse: the exact base origin passes,
 * every other port, host, alias and tunnel is refused and counted, a redirect is passed back unfollowed, and a large body is streamed.
 */
let app: Server;
let echo: TcpServer;
let spy: Server;
let appPort = 0;
let spyPort = 0;
let echoPort = 0;
let proxy: OriginProxy;
const spyHits: string[] = [];

const listen = (s: Server | TcpServer): Promise<number> => new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));

beforeAll(async () => {
  spy = createServer((req, res) => {
    spyHits.push(`${req.method} ${req.url}`);
    res.writeHead(200).end("spy");
  });
  spyPort = await listen(spy);
  app = createServer((req, res) => {
    if (req.url === "/redir") return void res.writeHead(302, { location: `http://127.0.0.1:${spyPort}/landed` }).end();
    if (req.url === "/big") {
      res.writeHead(200);
      const chunk = Buffer.alloc(1 << 20, 97);
      let sent = 0;
      const pump = (): void => {
        while (sent < 50) {
          sent++;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      return pump();
    }
    res.writeHead(200, { "x-seen-proxy-headers": String(req.headers["proxy-authorization"] ?? "") }).end(`hello ${req.method} ${req.url}`);
  });
  appPort = await listen(app);
  echo = createTcpServer((socket) => socket.pipe(socket));
  echoPort = await listen(echo);
  proxy = await startOriginProxy(parseBase(`http://127.0.0.1:${appPort}`)!);
});
afterAll(async () => {
  await proxy.close();
  app.close();
  spy.close();
  echo.close();
});

/** A plain forward-proxy request: the request line carries the whole address. */
function viaProxy(address: string, method = "GET"): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxy.port, method, path: address, headers: { host: address.startsWith("http") ? new URL(address).host : "x", "proxy-authorization": "secret" } }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A CONNECT request: the status line the proxy answers with, and then whether the tunnel carries bytes. */
function tunnel(authority: string): Promise<{ status: string; echoed: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy.port, "127.0.0.1", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nhost: ${authority}\r\n\r\n`));
    let seen = "";
    let sent = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      seen += chunk;
      if (!sent && seen.includes("\r\n\r\n") && seen.startsWith("HTTP/1.1 200")) {
        sent = true;
        seen = "";
        socket.write("ping");
      } else if (sent && seen.includes("ping")) {
        socket.destroy();
        resolve({ status: "200", echoed: seen });
      }
    });
    socket.on("close", () => resolve({ status: seen.split("\r\n")[0] ?? "", echoed: "" }));
    socket.on("error", reject);
    setTimeout(() => socket.destroy(), 3_000).unref();
  });
}

describe("the origin proxy", () => {
  it("passes a request to the exact base origin, without the proxy's own headers", async () => {
    const out = await viaProxy(`http://127.0.0.1:${appPort}/x?y=1`);
    expect(out.status).toBe(200);
    expect(out.body).toBe("hello GET /x?y=1");
    expect(out.headers["x-seen-proxy-headers"]).toBe("");
  });

  it("refuses another port of the base host, another host, a localhost alias, another scheme and a bad request line, and counts each", async () => {
    const before = proxy.refused();
    for (const address of [`http://127.0.0.1:${spyPort}/a`, `http://127.0.0.2:${appPort}/b`, `http://localhost:${appPort}/c`, `https://127.0.0.1:${appPort}/d`, "http://example.test/e", "/relative"]) {
      expect((await viaProxy(address)).status, address).toBe(403);
    }
    expect(proxy.refused() - before).toBe(6);
    expect(spyHits).toEqual([]);
  });

  it("refuses a method-changing POST to another origin just the same", async () => {
    expect((await viaProxy(`http://127.0.0.1:${spyPort}/post`, "POST")).status).toBe(403);
    expect(spyHits).toEqual([]);
  });

  it("does not follow a redirect: it hands the 302 back and nothing reaches the target", async () => {
    const out = await viaProxy(`http://127.0.0.1:${appPort}/redir`);
    expect(out.status).toBe(302);
    expect(out.headers.location).toBe(`http://127.0.0.1:${spyPort}/landed`);
    expect(spyHits).toEqual([]);
  });

  it("tunnels to the base host and port, and refuses a tunnel to another port, another host or a localhost alias", async () => {
    const base = await startOriginProxy(parseBase(`http://127.0.0.1:${echoPort}`)!);
    const prior = proxy;
    proxy = base;
    try {
      expect((await tunnel(`127.0.0.1:${echoPort}`)).echoed).toBe("ping");
      const before = base.refused();
      for (const authority of [`127.0.0.1:${spyPort}`, `127.0.0.1:${appPort}`, `localhost:${echoPort}`, `127.0.0.2:${echoPort}`, "example.test:443", "127.0.0.1"]) {
        const out = await tunnel(authority);
        expect(out.status, authority).toContain("403");
        expect(out.echoed, authority).toBe("");
      }
      expect(base.refused() - before).toBe(6);
    } finally {
      proxy = prior;
      await base.close();
    }
    expect(spyHits).toEqual([]);
  });

  it("streams a large body: it does not hold it", { timeout: 60_000 }, async () => {
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => void (peak = Math.max(peak, process.memoryUsage().rss)), 10);
    const out = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: proxy.port, path: `http://127.0.0.1:${appPort}/big`, headers: { host: `127.0.0.1:${appPort}` } }, (res) => {
        let total = 0;
        res.on("data", (c: Buffer) => (total += c.length));
        res.on("end", () => resolve(total));
      });
      req.on("error", reject);
      req.end();
    });
    clearInterval(timer);
    expect(out).toBe(50 * (1 << 20));
    expect(peak - before).toBeLessThan(150 * 1024 * 1024);
  });
});
