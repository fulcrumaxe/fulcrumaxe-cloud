// The write fence: browser context and API client, production and staging, against local servers. A request the
// fence refuses never reaches the server, so every refusal below is proved by the server's own request count.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bypassRouteHandler } from "../fixtures/bypass.js";
import { installBrowserFence, newFencedContext } from "../fixtures/fence.js";
import { BYPASS_HEADER, canonicalHost, ClientError, createClient, fenceVerdict, isSameHost, SHELL_WRITE_ALLOWLIST, type FenceConfig } from "../src/client.js";
import { main } from "../src/cli.js";
import { BYPASS_ENV } from "../src/needs.js";
import { PRODUCTION_ORIGIN_ENV, fenceConfigFor, productionOriginFor, TargetError } from "../src/targets.js";
import { childEnv } from "../src/run.js";
import { makeIo, makePack, makeTarget, PACKAGE_ROOT, tmpDir } from "./helpers.js";

const SECRET = `t1c${randomBytes(12).toString("hex")}`;

interface Seen {
  method: string;
  path: string;
  bypass: string | undefined;
  body: string;
}

/**
 * A local server. `/r301`, `/r302`, `/r307` and `/r308` with `?to=URL` answer with that status and Location, whatever the method;
 * `redirectTo` additionally makes `/to-other` a 307. Every request is recorded, and so is every WebSocket upgrade
 * (the socket is then dropped), because a refusal is proved by the server's own count staying at 0.
 */
function listen(seen: Seen[], redirectTo?: () => string, upgrades: string[] = []): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    const entry: Seen = { method: req.method ?? "", path: req.url ?? "", bypass: req.headers[BYPASS_HEADER] as string | undefined, body: "" };
    seen.push(entry);
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      entry.body = Buffer.concat(chunks).toString("utf8");
    });
    const url = new URL(req.url ?? "/", "http://x.test");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "*" });
      res.end();
    } else if (redirectTo !== undefined && req.url === "/to-other") {
      res.writeHead(307, { location: redirectTo() });
      res.end();
    } else if (/^\/r30[12378]$/.test(url.pathname)) {
      res.writeHead(Number(url.pathname.slice(2)), { location: url.searchParams.get("to") ?? "/", "access-control-allow-origin": "*" });
      res.end();
    } else if (req.url === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("self.addEventListener('fetch', () => {});");
    } else if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>t</title>");
    } else {
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "*" });
      res.end("ok");
    }
  });
  server.on("upgrade", (req, socket) => {
    upgrades.push(req.url ?? "");
    socket.destroy();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/**
 * The fence compares hostnames, so two local servers need two hostnames: the "production" one is reached as
 * `localhost`, the "staging" one (and any other) as `127.0.0.1`. Both resolve to this machine.
 */
const originOf = (s: Server, host = "127.0.0.1"): string => `http://${host}:${(s.address() as AddressInfo).port}`;
const prodOriginOf = (s: Server): string => originOf(s, "localhost");
const nonGets = (seen: Seen[]): Seen[] => seen.filter((s) => s.method !== "GET" && s.method !== "HEAD");

describe("fenceVerdict (pure rule)", () => {
  const prod: FenceConfig = { target: "production", targetOrigin: "https://prod.example.test" };
  const staging: FenceConfig = { target: "staging", targetOrigin: "https://stg.example.test", productionOrigin: "https://prod.example.test" };
  /** The same host spelled so that an exact origin comparison tells it apart. */
  const spellings = [
    "https://prod.example.test./x",
    "https://prod.example.test../x",
    "https://PROD.Example.TEST/x",
    "http://prod.example.test/x",
    "https://prod.example.test:8443/x",
    "http://prod.example.test.:8080/x",
    "https://prod.example.test%2E/x",
  ];

  it("canonicalHost lowercases and strips trailing dots; scheme and port are left out", () => {
    expect(canonicalHost("https://Prod.Example.test.:8443/x")).toBe("prod.example.test");
    expect(canonicalHost("not a url")).toBeUndefined();
    expect(isSameHost("http://prod.example.test./y", "https://prod.example.test")).toBe(true);
    expect(isSameHost("https://prod.example.test.evil.test/y", "https://prod.example.test")).toBe(false);
  });

  it("production: reads pass, non-reads to the production host are refused, other hosts are not the client's business", () => {
    expect(fenceVerdict({ method: "GET", url: "https://prod.example.test/x" }, prod)).toBeNull();
    expect(fenceVerdict({ method: "HEAD", url: "https://prod.example.test/x" }, prod)).toBeNull();
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      expect(fenceVerdict({ method: m, url: "https://prod.example.test/x" }, prod), m).toBe("production-write-fence");
    }
    expect(fenceVerdict({ method: "POST", url: "https://github.com/login" }, prod)).toBeNull();
  });

  it("production: a dotted, upper-case, http or other-port spelling of the production host is still the production host", () => {
    for (const url of spellings) {
      expect(fenceVerdict({ method: "POST", url }, prod), url).toBe("production-write-fence");
      expect(fenceVerdict({ method: "GET", url }, prod), `GET ${url}`).toBeNull();
    }
    // The configured origin may itself be spelled with a dot.
    expect(fenceVerdict({ method: "POST", url: "https://prod.example.test/x" }, { target: "production", targetOrigin: "https://prod.example.test." })).toBe("production-write-fence");
    for (const url of ["https://prod.example.test.evil.test/x", "https://xprod.example.test/x", "https://www.prod.example.test/x"]) {
      expect(fenceVerdict({ method: "POST", url }, prod), url).toBeNull();
    }
  });

  it("production: the browser refuses a non-read to ANY origin", () => {
    for (const url of ["https://github.com/login", "https://stg.example.test/api", "https://prod.example.test/x"]) {
      expect(fenceVerdict({ method: "POST", url, shell: true }, prod), url).toBe("production-write-fence");
      expect(fenceVerdict({ method: "GET", url, shell: true }, prod), `GET ${url}`).toBeNull();
    }
  });

  it("production: the shell allowlist is exact in method, path and origin, and only for the browser", () => {
    for (const a of SHELL_WRITE_ALLOWLIST) {
      expect(fenceVerdict({ method: a.method, url: `https://prod.example.test${a.path}`, shell: true }, prod), a.path).toBeNull();
      expect(fenceVerdict({ method: a.method, url: `https://prod.example.test${a.path}` }, prod), `${a.path} without shell`).toBe("production-write-fence");
      expect(fenceVerdict({ method: "DELETE", url: `https://prod.example.test${a.path}`, shell: true }, prod), `DELETE ${a.path}`).toBe("production-write-fence");
      expect(fenceVerdict({ method: a.method, url: `https://prod.example.test${a.path}/extra`, shell: true }, prod), `${a.path}/extra`).toBe("production-write-fence");
      // Not the exact origin: the same path on another spelling or another host is not the shell's own write.
      for (const origin of ["http://prod.example.test", "https://prod.example.test.", "https://prod.example.test:8443", "https://stg.example.test"]) {
        expect(fenceVerdict({ method: a.method, url: `${origin}${a.path}`, shell: true }, prod), `${origin}${a.path}`).toBe("production-write-fence");
      }
    }
  });

  it("production: a declared probe passes only on the exact target origin", () => {
    expect(fenceVerdict({ method: "POST", url: "https://prod.example.test/x", probe: true }, prod)).toBeNull();
    expect(fenceVerdict({ method: "POST", url: "https://prod.example.test./x", probe: true }, prod)).toBe("production-write-fence");
  });

  it("staging: any method to the production host is refused, in every spelling of it", () => {
    for (const m of ["GET", "HEAD", "POST", "DELETE"]) {
      expect(fenceVerdict({ method: m, url: "https://prod.example.test/x" }, staging), m).toBe("staging-blocks-production");
    }
    for (const url of spellings) expect(fenceVerdict({ method: "GET", url }, staging), url).toBe("staging-blocks-production");
    expect(fenceVerdict({ method: "GET", url: "https://prod.example.test/x" }, { ...staging, productionOrigin: "https://PROD.example.test." })).toBe("staging-blocks-production");
    // Look-alikes are other hosts, not the production one.
    for (const url of ["https://prod.example.test.evil.test/x", "https://xprod.example.test/x", "https://www.prod.example.test/x"]) {
      expect(fenceVerdict({ method: "GET", url }, staging), url).toBeNull();
    }
    expect(fenceVerdict({ method: "POST", url: "https://stg.example.test/api" }, staging)).toBeNull();
  });

  it("staging with no production origin refuses everything, whatever the method or host", () => {
    const noOrigin: FenceConfig = { target: "staging", targetOrigin: "https://stg.example.test" };
    for (const m of ["GET", "HEAD", "POST", "DELETE"]) {
      for (const url of ["https://stg.example.test/x", "https://prod.example.test/x"]) {
        expect(fenceVerdict({ method: m, url }, noOrigin), `${m} ${url}`).toBe("staging-no-production-origin");
      }
    }
  });
});

describe("browser fence in real Chromium", () => {
  const seenProd: Seen[] = [];
  const seenStg: Seen[] = [];
  const seenElse: Seen[] = [];
  const upgradesProd: string[] = [];
  const upgradesStg: string[] = [];
  let prod: Server;
  let stg: Server;
  let elsewhere: Server;
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  const prodOrigin = (): string => prodOriginOf(prod);
  const stgOrigin = (): string => originOf(stg);
  const port = (s: Server): number => (s.address() as AddressInfo).port;

  beforeAll(async () => {
    prod = await listen(seenProd, undefined, upgradesProd);
    stg = await listen(seenStg, undefined, upgradesStg);
    elsewhere = await listen(seenElse);
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => {
    for (const c of contexts) await c.close();
    await browser?.close();
    prod.close();
    stg.close();
    elsewhere.close();
  });

  function reset(): void {
    for (const list of [seenProd, seenStg, seenElse, upgradesProd, upgradesStg]) list.length = 0;
  }

  async function pageOn(context: BrowserContext, origin: string): Promise<Page> {
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    return page;
  }

  /** A context with no fence at all: the control that shows a test can fail. */
  const plainContext = (): Promise<BrowserContext> => browser.newContext({ serviceWorkers: "block" });

  /** Sends a request from the page; resolves to the status, or "blocked" when the browser could not send it. */
  const send = (page: Page, method: string, url: string, mode: "cors" | "no-cors" = "cors"): Promise<number | string> =>
    page.evaluate<number | string>(`fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, mode: ${JSON.stringify(mode)} }).then((r) => r.status, () => "blocked")`);

  /** Submits an HTML form POST (a navigation) and waits until it either failed or loaded. */
  async function postForm(page: Page, url: string): Promise<void> {
    const settled = Promise.race([page.waitForEvent("requestfailed", { timeout: 15_000 }), page.waitForEvent("load", { timeout: 15_000 })]).catch(() => undefined);
    await page
      .evaluate(
        `(() => { const f = document.createElement("form"); f.method = "POST"; f.action = ${JSON.stringify(url)}; const i = document.createElement("input"); i.name = "a"; i.value = "1"; f.appendChild(i); document.body.appendChild(f); f.submit(); })()`,
      )
      .catch(() => undefined);
    await settled;
  }

  /** Opens a WebSocket from the page; resolves when it closed (or after 4 seconds). */
  const openSocket = (page: Page, url: string): Promise<string> =>
    page.evaluate<string>(`new Promise((resolve) => { const w = new WebSocket(${JSON.stringify(url)}); w.onclose = () => resolve("closed"); setTimeout(() => resolve("timeout"), 4000); })`);

  const writes = ["fetch", "form"] as const;
  const redirectStatuses = [307, 308] as const;
  const via = (origin: string, status: number, to: string): string => `${origin}/r${status}?to=${encodeURIComponent(to)}`;
  const carry = (page: Page, kind: (typeof writes)[number], url: string): Promise<unknown> => (kind === "fetch" ? send(page, "POST", url, "no-cors") : postForm(page, url));

  it("production: POST, PUT, PATCH and DELETE are aborted and never reach the server; GET and the shell's writes do", async () => {
    reset();
    const config: FenceConfig = { target: "production", targetOrigin: prodOrigin() };
    const page = await pageOn(await newFencedContext(browser, config), prodOrigin());
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(await send(page, m, `${prodOrigin()}/api/v1/thing`), m).toBe("blocked");
    expect(nonGets(seenProd)).toHaveLength(0);

    expect(await send(page, "GET", `${prodOrigin()}/api/v1/thing`)).toBe(200);
    // Sign-in is GET-only in the app, so it is an ordinary read; the three writes the shell makes are allowlisted.
    expect(await send(page, "GET", `${prodOrigin()}/api/auth/github`)).toBe(200);
    for (const a of SHELL_WRITE_ALLOWLIST) expect(await send(page, a.method, `${prodOrigin()}${a.path}`), a.path).toBe(200);
    expect(nonGets(seenProd).map((s) => `${s.method} ${s.path}`)).toEqual(SHELL_WRITE_ALLOWLIST.map((a) => `${a.method} ${a.path}`));
  }, 60_000);

  it("production: a non-read to ANY other origin is aborted too, including the shell's paths there", async () => {
    reset();
    const config: FenceConfig = { target: "production", targetOrigin: prodOrigin() };
    const page = await pageOn(await newFencedContext(browser, config), prodOrigin());
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(await send(page, m, `${stgOrigin()}/api/v1/thing`, "no-cors"), m).toBe("blocked");
    for (const a of SHELL_WRITE_ALLOWLIST) expect(await send(page, a.method, `${stgOrigin()}${a.path}`, "no-cors"), a.path).toBe("blocked");
    expect(seenStg).toHaveLength(0);
    // A read to another origin is not fenced.
    expect(await send(page, "GET", `${stgOrigin()}/api/v1/thing`)).toBe(200);
    expect(seenStg.map((s) => s.method)).toEqual(["GET"]);
  }, 60_000);

  it("production: another spelling of the production host is the production host (dotted, http scheme)", async () => {
    reset();
    const dotted = `http://localhost.:${port(prod)}`;
    // The configured origin is https while the local server speaks http, so only the host can match.
    const config: FenceConfig = { target: "production", targetOrigin: `https://localhost:${port(prod)}` };
    const page = await pageOn(await newFencedContext(browser, config), prodOrigin());
    for (const url of [`${prodOrigin()}/x`, `${dotted}/x`]) expect(await send(page, "POST", url, "no-cors"), url).toBe("blocked");
    expect(seenProd.filter((s) => s.path === "/x")).toHaveLength(0);
    // Control: without the fence both reach the server.
    const plain = await pageOn(await plainContext(), prodOrigin());
    for (const url of [`${prodOrigin()}/x`, `${dotted}/x`]) await send(plain, "POST", url, "no-cors");
    expect(seenProd.filter((s) => s.method === "POST" && s.path === "/x")).toHaveLength(2);
  }, 60_000);

  it("production: a 307 or 308 from another origin cannot carry a write to production (fetch and form)", async () => {
    for (const status of redirectStatuses) {
      for (const kind of writes) {
        reset();
        const url = via(stgOrigin(), status, `${prodOrigin()}/landed`);
        const page = await pageOn(await newFencedContext(browser, { target: "production", targetOrigin: prodOrigin() }), prodOrigin());
        await carry(page, kind, url);
        expect(nonGets(seenProd), `${status} ${kind}`).toHaveLength(0);
        expect(nonGets(seenStg), `${status} ${kind} reached the redirecting origin`).toHaveLength(0);

        // Control: the same page without the fence lands the write on the production server.
        reset();
        await carry(await pageOn(await plainContext(), prodOrigin()), kind, url);
        expect(nonGets(seenProd).map((s) => `${s.method} ${s.path}`), `control ${status} ${kind}`).toEqual(["POST /landed"]);
      }
    }
  }, 120_000);

  it("production: the context blocks service workers", async () => {
    const config: FenceConfig = { target: "production", targetOrigin: prodOrigin() };
    const page = await pageOn(await newFencedContext(browser, config), prodOrigin());
    const registered = (p: typeof page) =>
      p.evaluate<number>("navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.getRegistrations().then((r) => r.length), () => -1)");
    // Control: the same page in a plain context does get a worker, so the blocked count below is the option at work.
    const plain = await browser.newContext();
    contexts.push(plain);
    const plainPage = await plain.newPage();
    await plainPage.goto(`${prodOrigin()}/`);
    expect(await registered(plainPage)).toBe(1);
    expect(await registered(page)).not.toBe(1);
  }, 60_000);

  it("staging: every request to the production origin is aborted, whatever the method; the staging origin is untouched", async () => {
    reset();
    const config: FenceConfig = { target: "staging", targetOrigin: stgOrigin(), productionOrigin: prodOrigin() };
    const page = await pageOn(await newFencedContext(browser, config), stgOrigin());
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) expect(await send(page, m, `${prodOrigin()}/x`, "no-cors"), m).toBe("blocked");
    expect(seenProd).toHaveLength(0);
    expect(await send(page, "POST", `${stgOrigin()}/api/v1/thing`)).toBe(200);
    expect(nonGets(seenStg).map((s) => s.method)).toEqual(["POST"]);
  }, 60_000);

  it("staging: a dotted or http spelling of the production host is aborted too, direct and as a redirect target", async () => {
    const p = port(prod);
    const cases = [
      { name: "plain", fenced: prodOrigin(), to: `${prodOrigin()}/landed` },
      { name: "trailing dot", fenced: prodOrigin(), to: `http://localhost.:${p}/landed` },
      { name: "http scheme", fenced: `https://localhost:${p}`, to: `http://localhost:${p}/landed` },
    ];
    for (const c of cases) {
      const config: FenceConfig = { target: "staging", targetOrigin: stgOrigin(), productionOrigin: c.fenced };
      for (const status of redirectStatuses) {
        for (const kind of writes) {
          reset();
          const page = await pageOn(await newFencedContext(browser, config), stgOrigin());
          await carry(page, kind, via(stgOrigin(), status, c.to));
          expect(seenProd, `${c.name} ${status} ${kind}`).toHaveLength(0);

          reset();
          await carry(await pageOn(await plainContext(), stgOrigin()), kind, via(stgOrigin(), status, c.to));
          expect(nonGets(seenProd).map((s) => `${s.method} ${s.path}`), `control ${c.name} ${status} ${kind}`).toEqual(["POST /landed"]);
        }
      }
      // Direct requests, any method.
      reset();
      const page = await pageOn(await newFencedContext(browser, config), stgOrigin());
      for (const url of [c.to, `${c.to}?again`]) expect(await send(page, "POST", url, "no-cors"), url).toBe("blocked");
      expect(seenProd, `${c.name} direct`).toHaveLength(0);
    }
  }, 240_000);

  /** The method a redirected write arrives with (Fetch spec): a POST answered 301 or 302, and any write answered 303, becomes a GET. */
  const arrivesAs = (status: number, method: string): string => (status === 303 || (method === "POST" && (status === 301 || status === 302)) ? "GET" : method);
  const writeMethods = ["POST", "PUT", "PATCH", "DELETE"] as const;
  /** A same-origin write from the staging page, with a body when the method takes one. Resolves to a status or "blocked". */
  const sendWrite = (page: Page, method: string, url: string): Promise<number | string> =>
    page.evaluate<number | string>(
      `fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, ${method === "DELETE" ? "" : 'body: "b", '}redirect: "follow" }).then((r) => r.status, () => "blocked")`,
    );
  const landed = (seen: Seen[]): string[] => seen.filter((s) => s.method !== "OPTIONS").map((s) => `${s.method} ${s.path}`);

  it("staging: a write answered with ANY 3xx is aborted, whatever the Location, and the production count stays 0", async () => {
    const config: FenceConfig = { target: "staging", targetOrigin: stgOrigin(), productionOrigin: prodOrigin() };
    for (const status of [301, 302, 307, 308]) {
      for (const method of writeMethods) {
        const to = `${prodOrigin()}/landed-${method}`;
        reset();
        const page = await pageOn(await newFencedContext(browser, config), stgOrigin());
        expect(await sendWrite(page, method, via(stgOrigin(), status, to)), `${status} ${method}`).toBe("blocked");
        expect(seenProd, `${status} ${method} reached production`).toHaveLength(0);

        // Control: the same page without the fence lands the request on the production server.
        reset();
        await sendWrite(await pageOn(await plainContext(), stgOrigin()), method, via(stgOrigin(), status, to));
        expect(landed(seenProd), `control ${status} ${method}`).toEqual([`${arrivesAs(status, method)} /landed-${method}`]);
      }
    }
  }, 240_000);

  it("staging: a write redirected to a non-production origin is aborted as well; nothing is fulfilled", async () => {
    const config: FenceConfig = { target: "staging", targetOrigin: stgOrigin(), productionOrigin: prodOrigin() };
    for (const status of [301, 302, 303, 307, 308]) {
      reset();
      const page = await pageOn(await newFencedContext(browser, config), stgOrigin());
      expect(await sendWrite(page, "POST", via(stgOrigin(), status, `${originOf(elsewhere)}/landed`)), String(status)).toBe("blocked");
      await postForm(page, via(stgOrigin(), status, `${originOf(elsewhere)}/landed`));
      expect(seenElse, `${status} reached the other origin`).toHaveLength(0);
      expect(seenProd).toHaveLength(0);

      reset();
      await sendWrite(await pageOn(await plainContext(), stgOrigin()), "POST", via(stgOrigin(), status, `${originOf(elsewhere)}/landed`));
      expect(landed(seenElse), `control ${status}`).toEqual([`${arrivesAs(status, "POST")} /landed`]);
    }
  }, 120_000);

  it("staging: a two-hop chain of redirects, on the same host or through a third, cannot land a write on production", async () => {
    const config: FenceConfig = { target: "staging", targetOrigin: stgOrigin(), productionOrigin: prodOrigin() };
    const chains: { name: string; url: (status: number, to: string) => string }[] = [
      { name: "same host", url: (status, to) => via(stgOrigin(), status, via(stgOrigin(), status, to)) },
      { name: "via a third host", url: (status, to) => via(stgOrigin(), status, via(originOf(elsewhere), status, to)) },
    ];
    for (const chain of chains) {
      for (const status of [301, 302, 307, 308]) {
        const to = `${prodOrigin()}/landed`;
        // A form POST, then the other three methods through fetch.
        reset();
        const page = await pageOn(await newFencedContext(browser, config), stgOrigin());
        for (const method of ["PUT", "PATCH", "DELETE"]) await sendWrite(page, method, chain.url(status, to));
        await postForm(page, chain.url(status, to));
        expect(seenProd, `${chain.name} ${status}`).toHaveLength(0);

        reset();
        const plain = await pageOn(await plainContext(), stgOrigin());
        for (const method of ["PUT", "PATCH", "DELETE"]) await sendWrite(plain, method, chain.url(status, to));
        await postForm(plain, chain.url(status, to));
        const expected = writeMethods.map((m) => `${arrivesAs(status, m)} /landed`);
        expect(landed(seenProd).sort(), `control ${chain.name} ${status}`).toEqual(expected.sort());
      }
    }
  }, 300_000);

  it("staging: the fence's own fetch of a write carries the extra headers it was given, for the target only", async () => {
    reset();
    const config: FenceConfig = { target: "staging", targetOrigin: stgOrigin(), productionOrigin: prodOrigin() };
    const extraHeaders = (url: string): Record<string, string> => (url.startsWith(stgOrigin()) ? { [BYPASS_HEADER]: SECRET } : {});
    const page = await pageOn(await newFencedContext(browser, config, { extraHeaders }), stgOrigin());
    expect(await send(page, "POST", `${stgOrigin()}/api/v1/thing`)).toBe(200);
    expect(seenStg.filter((s) => s.method === "POST").map((s) => s.bypass)).toEqual([SECRET]);
    await send(page, "POST", `${originOf(elsewhere)}/other`, "no-cors");
    expect(seenElse.filter((s) => s.method === "POST").map((s) => s.bypass)).toEqual([undefined]);
  }, 60_000);

  it("both targets refuse a WebSocket to the production host (dotted too); other sockets connect", async () => {
    reset();
    const p = port(prod);
    const socketUrls = [`ws://localhost:${p}/ws`, `ws://localhost.:${p}/ws`];
    // Control: without the fence the upgrade reaches the server.
    const plain = await pageOn(await plainContext(), stgOrigin());
    expect(await openSocket(plain, socketUrls[0] as string)).toBe("closed");
    expect(upgradesProd.length).toBeGreaterThan(0);

    reset();
    const staging = await pageOn(await newFencedContext(browser, { target: "staging", targetOrigin: stgOrigin(), productionOrigin: prodOrigin() }), stgOrigin());
    for (const url of socketUrls) await openSocket(staging, url);
    expect(upgradesProd, "staging").toHaveLength(0);
    await openSocket(staging, `ws://127.0.0.1:${port(stg)}/ws`);
    expect(upgradesStg, "staging, its own socket").toHaveLength(1);

    reset();
    const production = await pageOn(await newFencedContext(browser, { target: "production", targetOrigin: prodOrigin() }), prodOrigin());
    for (const url of socketUrls) await openSocket(production, url);
    expect(upgradesProd, "production").toHaveLength(0);
  }, 120_000);

  it("the fence runs before the bypass handler and hands allowed requests on to it", async () => {
    reset();
    const config: FenceConfig = { target: "production", targetOrigin: prodOrigin() };
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", bypassRouteHandler(prodOrigin(), SECRET));
    await installBrowserFence(context, config);
    const page = await pageOn(context, prodOrigin());
    expect(await send(page, "GET", `${prodOrigin()}/api/v1/thing`)).toBe(200);
    expect(await send(page, "POST", `${prodOrigin()}/api/v1/thing`)).toBe("blocked");
    expect(seenProd.every((s) => s.bypass === SECRET)).toBe(true);
    expect(nonGets(seenProd)).toHaveLength(0);
  }, 60_000);
});

describe("API client fence", () => {
  const seenProd: Seen[] = [];
  const seenStg: Seen[] = [];
  let prod: Server;
  let stg: Server;

  beforeAll(async () => {
    prod = await listen(seenProd);
    stg = await listen(seenStg, () => `${prodOriginOf(prod)}/landed`);
  });
  afterAll(() => {
    prod.close();
    stg.close();
  });

  it("production: a non-GET throws before any socket opens (server count 0); a GET and a HEAD pass", async () => {
    seenProd.length = 0;
    const client = createClient({ origin: originOf(prod), bypassSecret: SECRET, fence: { target: "production", targetOrigin: originOf(prod) } });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(client.request("/api/v1/thing", { method }), method).rejects.toThrow(ClientError);
      await expect(client.request("/api/v1/thing", { method }), method).rejects.toThrow("production-write-fence");
    }
    expect(seenProd).toHaveLength(0);
    expect((await client.get("/api/v1/thing")).status).toBe(200);
    expect((await client.request("/api/v1/thing", { method: "HEAD" })).status).toBe(200);
    expect(seenProd.map((s) => s.method)).toEqual(["GET", "HEAD"]);
  });

  it("production: the production host in another spelling is still fenced", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    // The client talks to a dotted spelling of the host the fence guards.
    const client = createClient({ origin: "https://prod.example.test.", fetchImpl, fence: { target: "production", targetOrigin: "https://prod.example.test" } });
    await expect(client.request("/x", { method: "POST" })).rejects.toThrow("production-write-fence");
    expect(calls).toEqual([]);
    expect((await client.get("/x")).status).toBe(200);
  });

  it("a client built without a fence is fenced as production", async () => {
    seenProd.length = 0;
    await expect(createClient({ origin: originOf(prod) }).request("/x", { method: "POST" })).rejects.toThrow("reads only");
    expect(seenProd).toHaveLength(0);
  });

  it("staging: a GET hop to the production origin throws before a socket opens; a POST answered with a redirect throws too", async () => {
    seenProd.length = 0;
    seenStg.length = 0;
    const client = createClient({
      origin: originOf(stg),
      fence: { target: "staging", targetOrigin: originOf(stg), productionOrigin: prodOriginOf(prod) },
    });
    await expect(client.get("/to-other")).rejects.toThrow("staging-blocks-production");
    await expect(client.request("/to-other", { method: "POST" })).rejects.toThrow("never followed");
    expect(seenProd).toHaveLength(0);
    expect(seenStg.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /to-other", "POST /to-other"]);
  });

  it("staging: a redirect hop to a dotted, upper-case, http or other-port spelling of the production host throws, GET and POST", async () => {
    const hops = ["https://prod.example.test./x", "https://PROD.example.test/x", "http://prod.example.test/x", "https://prod.example.test:8443/x"];
    for (const location of hops) {
      for (const method of ["GET", "POST"]) {
        const calls: string[] = [];
        const fetchImpl = (async (url: string) => {
          calls.push(url);
          return new Response(null, { status: method === "GET" ? 302 : 307, headers: { location } });
        }) as unknown as typeof fetch;
        const client = createClient({
          origin: "https://stg.example.test",
          fetchImpl,
          fence: { target: "staging", targetOrigin: "https://stg.example.test", productionOrigin: "https://prod.example.test" },
        });
        await expect(client.request("/go", { method }), `${method} ${location}`).rejects.toThrow(method === "GET" ? "staging-blocks-production" : "never followed");
        expect(calls, `${method} ${location}`).toEqual(["https://stg.example.test/go"]);
      }
    }
  });

  it("staging: an ordinary write to the staging origin is allowed", async () => {
    seenStg.length = 0;
    const client = createClient({ origin: originOf(stg), fence: { target: "staging", targetOrigin: originOf(stg), productionOrigin: prodOriginOf(prod) } });
    expect((await client.request("/api/v1/thing", { method: "POST" })).status).toBe(200);
    expect(seenStg.map((s) => s.method)).toEqual(["POST"]);
  });

  it("a write answered with a 3xx is an error on either target, whatever the Location, and is never followed", async () => {
    const targets: FenceConfig[] = [
      { target: "staging", targetOrigin: "https://stg.example.test", productionOrigin: "https://prod.example.test" },
      { target: "production", targetOrigin: "https://stg.example.test" },
    ];
    for (const fence of targets) {
      for (const status of [301, 302, 303, 307, 308]) {
        for (const location of ["/same-origin", "https://elsewhere.example.test/x", "https://prod.example.test/x"]) {
          const calls: string[] = [];
          const fetchImpl = (async (url: string) => {
            calls.push(url);
            return new Response(null, { status, headers: { location } });
          }) as unknown as typeof fetch;
          const client = createClient({ origin: "https://stg.example.test", fetchImpl, fence });
          // Production refuses the write itself; staging reaches the socket, gets the 3xx and refuses to follow it.
          await expect(client.request("/go", { method: "POST" }), `${fence.target} ${status} ${location}`).rejects.toThrow(ClientError);
          expect(calls.length, `${fence.target} ${status} ${location}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("staging: every write method answered with a 3xx throws and makes exactly one request; a GET is still followed", async () => {
    const seenElsewhere: Seen[] = [];
    const seenRedirecting: Seen[] = [];
    const elsewhere = await listen(seenElsewhere);
    const redirecting = await listen(seenRedirecting, () => `${originOf(elsewhere)}/landed`);
    try {
      const client = createClient({ origin: originOf(redirecting), fence: { target: "staging", targetOrigin: originOf(redirecting), productionOrigin: prodOriginOf(prod) } });
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        await expect(client.request("/to-other", { method, body: "x" }), method).rejects.toThrow("never followed");
      }
      expect(seenRedirecting.map((s) => s.method)).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
      expect(seenElsewhere).toHaveLength(0);
      expect((await client.get("/to-other")).status).toBe(200);
      expect(seenElsewhere.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /landed"]);
    } finally {
      elsewhere.close();
      redirecting.close();
    }
  });

  it("staging with no production origin refuses every request before a socket opens", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response("ok");
    }) as unknown as typeof fetch;
    const client = createClient({ origin: "https://stg.example.test", fetchImpl, fence: { target: "staging", targetOrigin: "https://stg.example.test" } });
    await expect(client.get("/x")).rejects.toThrow("staging-no-production-origin");
    await expect(client.request("/x", { method: "POST" })).rejects.toThrow("staging-no-production-origin");
    expect(calls).toHaveLength(0);
  });

  it("staging: a look-alike of the production origin is not the production origin", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://prod.example.test.evil.test/x" } })
        : new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const client = createClient({
      origin: "https://stg.example.test",
      fetchImpl,
      fence: { target: "staging", targetOrigin: "https://stg.example.test", productionOrigin: "https://prod.example.test" },
    });
    expect((await client.get("/go")).status).toBe(200);
    expect(calls).toEqual(["https://stg.example.test/go", "https://prod.example.test.evil.test/x"]);
  });
});

describe("the production origin on a staging run", () => {
  const targetsDir = join(PACKAGE_ROOT, "targets");

  it("is read from the variable production.json names", () => {
    expect(JSON.parse(readProductionFile()).origin_env).toBe(PRODUCTION_ORIGIN_ENV);
    expect(productionOriginFor(targetsDir, { [PRODUCTION_ORIGIN_ENV]: "https://prod.example.test" })).toBe("https://prod.example.test");
  });

  it("is absent when the variable is unset or empty, and a malformed value is an error, not a silent no-op", () => {
    expect(productionOriginFor(targetsDir, {})).toBeUndefined();
    expect(productionOriginFor(targetsDir, { [PRODUCTION_ORIGIN_ENV]: "  " })).toBeUndefined();
    for (const bad of ["http://prod.example.test", "https://prod.example.test/", "prod.example.test", "https://prod.example.test/path"]) {
      expect(() => productionOriginFor(targetsDir, { [PRODUCTION_ORIGIN_ENV]: bad }), bad).toThrow(TargetError);
    }
  });

  it("a value whose host ends in a dot is refused, not stored", () => {
    for (const bad of ["https://prod.example.test.", "https://prod.example.test.:8443", "https://prod.example.test.."]) {
      expect(() => productionOriginFor(targetsDir, { [PRODUCTION_ORIGIN_ENV]: bad }), bad).toThrow("trailing dot");
    }
  });

  it("fenceConfigFor: production fences writes, staging carries the production origin", () => {
    const env = { [PRODUCTION_ORIGIN_ENV]: "https://prod.example.test" };
    expect(fenceConfigFor(makeTarget({ name: "production", origin: "https://prod.example.test" }), targetsDir, env)).toEqual({
      target: "production",
      targetOrigin: "https://prod.example.test",
    });
    expect(fenceConfigFor(makeTarget(), targetsDir, env)).toEqual({
      target: "staging",
      targetOrigin: "https://staging.example.test",
      productionOrigin: "https://prod.example.test",
    });
  });

  it("fails closed: a staging fence without the production origin is a TargetError naming the variable", () => {
    for (const env of [{}, { [PRODUCTION_ORIGIN_ENV]: "" }, { [PRODUCTION_ORIGIN_ENV]: "  " }]) {
      expect(() => fenceConfigFor(makeTarget(), targetsDir, env)).toThrow(TargetError);
      expect(() => fenceConfigFor(makeTarget(), targetsDir, env)).toThrow(PRODUCTION_ORIGIN_ENV);
    }
    // Production never needed it, and its own fence does not depend on it.
    expect(fenceConfigFor(makeTarget({ name: "production", origin: "https://prod.example.test" }), targetsDir, {})).toEqual({ target: "production", targetOrigin: "https://prod.example.test" });
  });

  it("run --target staging refuses before any child process starts; plan is unaffected", async () => {
    const dir = tmpDir();
    const { io, err } = makeIo(PACKAGE_ROOT, { [BYPASS_ENV]: SECRET, [PRODUCTION_ORIGIN_ENV]: undefined });
    io.cwd = dir;
    let started = 0;
    io.exec = async () => {
      started += 1;
      return { code: 0, output: "" };
    };
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], io)).toBe(2);
    expect(started).toBe(0);
    expect(err.join("\n")).toContain(PRODUCTION_ORIGIN_ENV);
    expect(await main(["plan", "--target", "staging", "--tier", "smoke"], io)).toBe(0);
    expect(started).toBe(0);
  });

  it("a staging pack process is handed the production origin, a production one is not", () => {
    const env = { [PRODUCTION_ORIGIN_ENV]: "https://prod.example.test" };
    const pack = makePack({ id: "p" });
    expect(childEnv(pack, makeTarget(), env, "/out")[PRODUCTION_ORIGIN_ENV]).toBe("https://prod.example.test");
    expect(childEnv(pack, makeTarget({ name: "production" }), env, "/out")[PRODUCTION_ORIGIN_ENV]).toBeUndefined();
  });
});

function readProductionFile(): string {
  return readFileSync(join(PACKAGE_ROOT, "targets", "production.json"), "utf8");
}
