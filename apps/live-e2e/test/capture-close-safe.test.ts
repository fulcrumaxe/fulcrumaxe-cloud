/**
 * Closing the capture window while a route handler still has a request in flight must neither crash the command
 * nor print what Playwright puts in its error text (the request call log: every header, so the bypass secret and the
 * session cookie). Sentinel values are used for both, and every output stream is checked for them.
 *
 * Not faked: Playwright's own route machinery (the handler is driven with a stand-in Route whose `fetch` rejects when
 * the browser closes, the way `route.fetch` rejected with "Request context disposed" in the owner's run).
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bypassRouteHandler, withBypass, type RouteLike } from "../fixtures/bypass.js";
import { fenceRouteHandler } from "../fixtures/fence.js";
import { main, type Io } from "../src/cli.js";
import { errorClassName, guardRejections } from "../src/safe-error.js";
import type { CaptureBrowser, Launcher } from "../src/sessions.js";
import { readStore, storePath } from "../src/store.js";
import { BYPASS_VALUE, FakeApp, signSession } from "./session-helpers.js";
import { makeIo, scratchRoot, tmpDir } from "./helpers.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const STAGING = "https://staging.example.test";
const keyBytes = randomBytes(32);
const COOKIE = signSession({ sid: "s1", sessionStart: NOW, lastSeenAt: NOW });
const JWT_SENTINEL = ["vercel", "jwt", "sentinel", "0007"].join("-"); // gitleaks:allow

class TargetClosedError extends Error {}

/** What Playwright's message looks like: the reason, then the call log with every request header. */
const playwrightMessage = (reason: string): string =>
  `${reason}\nCall log:\n  - fetching https://staging.example.test/style.css\n  - x-vercel-protection-bypass: ${BYPASS_VALUE}\n  - cookie: __Host-fx_session=${COOKIE}; _vercel_jwt=${JWT_SENTINEL}`;

const SENTINELS = [BYPASS_VALUE, COOKIE, JWT_SENTINEL, "x-vercel-protection-bypass", "Call log"];

function setup() {
  const home = tmpDir();
  const root = scratchRoot([]);
  const app = new FakeApp(STAGING, () => NOW);
  const { io, out, err } = makeIo(root, { HOME: home, LIVE_E2E_SESSION_KEY: keyBytes.toString("base64"), VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS_VALUE });
  const full: Io = { ...io, fetch: app.fetch, now: () => NOW };
  return { io: full, out, err, file: storePath(home, "staging") };
}

const argv = ["capture-session", "--target", "staging", "--role", "owner"];

function expectNoSentinel(lines: string[]): void {
  const text = lines.join("\n");
  for (const s of SENTINELS) expect(text, `output contained ${s.slice(0, 12)}...`).not.toContain(s);
}

interface InFlight {
  route: RouteLike<unknown>;
  /** Rejects the pending `route.fetch`, as the closing context does. */
  dispose(): void;
}

/** A route whose `fetch` stays pending until `dispose`, then rejects with Playwright's message. */
function pendingRoute(abort?: () => Promise<void>): InFlight {
  let reject!: (e: Error) => void;
  const pending = new Promise<never>((_, r) => (reject = r));
  return {
    route: {
      request: () => ({ url: () => `${STAGING}/style.css`, headers: () => ({ cookie: `__Host-fx_session=${COOKIE}` }) }),
      continue: async () => undefined,
      fetch: () => pending,
      fulfill: async () => undefined,
      ...(abort === undefined ? {} : { abort }),
    },
    dispose: () => reject(new TargetClosedError(playwrightMessage("route.fetch: Request context disposed."))),
  };
}

describe("a route handler that fails while the window closes", () => {
  it("the bypass handler swallows a fetch rejection, aborts what it can, and never throws", async () => {
    let aborted = 0;
    const { route, dispose } = pendingRoute(async () => void (aborted += 1));
    const handled = bypassRouteHandler(STAGING, BYPASS_VALUE)(route);
    dispose();
    await expect(handled).resolves.toBeUndefined();
    expect(aborted).toBe(1);
  });

  it("the bypass handler also survives fulfill and abort rejecting on a closed context", async () => {
    const route: RouteLike<unknown> = {
      request: () => ({ url: () => `${STAGING}/a.css`, headers: () => ({}) }),
      continue: async () => undefined,
      fetch: async () => ({}),
      fulfill: async () => Promise.reject(new TargetClosedError(playwrightMessage("route.fulfill: Target closed"))),
      abort: async () => Promise.reject(new TargetClosedError(playwrightMessage("route.abort: Target closed"))),
    };
    await expect(bypassRouteHandler(STAGING, BYPASS_VALUE)(route)).resolves.toBeUndefined();
    const plain: RouteLike<unknown> = { ...route, request: () => ({ url: () => "https://elsewhere.example.test/x", headers: () => ({}) }), continue: async () => Promise.reject(new TargetClosedError("closed")) };
    await expect(bypassRouteHandler(STAGING, BYPASS_VALUE)(plain)).resolves.toBeUndefined();
  });

  it("the write fence swallows a failing fulfill or abort too", async () => {
    const closed = (): Promise<never> => Promise.reject(new TargetClosedError(playwrightMessage("Target closed")));
    const route = {
      request: () => ({ url: () => `${STAGING}/api/thing`, method: () => "POST", headers: () => ({}) }),
      fetch: async () => ({ status: () => 200 }),
      fulfill: closed,
      abort: closed,
      fallback: closed,
    };
    const handler = fenceRouteHandler({ target: "staging", targetOrigin: STAGING, productionOrigin: "https://prod.example.test" });
    await expect(handler(route as never)).resolves.toBeUndefined();
  });

  it("capture-session still stores the cookie and exits 0 when an in-flight fetch rejects during close", async () => {
    const { io, out, err, file } = setup();
    const launcher: Launcher = async (o) => {
      const inflight = pendingRoute();
      // Playwright starts the handler and neither awaits nor catches it.
      void bypassRouteHandler(o.origin, o.bypassSecret ?? "")(inflight.route);
      return {
        cookie: async () => COOKIE,
        close: async () => inflight.dispose(),
      } satisfies CaptureBrowser;
    };
    const code = await main(argv, { ...io, launcher, abort: () => undefined });
    await new Promise((r) => setImmediate(r)); // let Node raise an unhandled rejection, if there is one
    expect(code).toBe(0);
    expect(readStore(file, "staging", keyBytes)).toEqual({ owner: COOKIE });
    expect(err).toEqual([]);
    expectNoSentinel(out);
  });
});

describe("the guard window and the fence", () => {
  it("a raw unhandled rejection raised by close() after the cookie is found still lets the store be written", async () => {
    const { io, out, err, file } = setup();
    let aborted = 0;
    const before = process.listenerCount("unhandledRejection");
    const launcher: Launcher = async () => ({
      cookie: async () => COOKIE,
      close: async () => {
        // A raw rejection nobody handles, raised inside captureSession's finally, as the incident's was.
        void Promise.reject(new TargetClosedError(playwrightMessage("route.fetch: Request context disposed.")));
        await new Promise((r) => setImmediate(r));
      },
    });
    // Vitest's own listener would report the deliberate rejection as a test error: only the command's guard sees it here.
    const others = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    let code: number;
    try {
      code = await main(argv, { ...io, launcher, abort: () => void (aborted += 1) });
      await new Promise((r) => setImmediate(r));
    } finally {
      for (const l of others) process.on("unhandledRejection", l);
    }
    expect(aborted).toBe(0);
    expect(code).toBe(1);
    expect(readStore(file, "staging", keyBytes)).toEqual({ owner: COOKIE });
    expectNoSentinel([...out, ...err]);
    expect(err.join("\n")).toContain("capture-session: failed unexpectedly (TargetClosedError)");
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });

  it("a rejection before the cookie is found still ends the capture (abort) and stores nothing", async () => {
    const { io, file } = setup();
    let aborted = 0;
    const launcher: Launcher = async () => ({
      cookie: async () => {
        void Promise.reject(new TargetClosedError(playwrightMessage("early")));
        await new Promise((r) => setImmediate(r));
        return undefined;
      },
      close: async () => undefined,
    });
    const others = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    try {
      const t = { v: NOW };
      await main(argv, { ...io, launcher, now: () => (t.v += 400_000), abort: () => void (aborted += 1) });
    } finally {
      for (const l of others) process.on("unhandledRejection", l);
    }
    expect(aborted).toBeGreaterThan(0);
    expect(() => readStore(file, "staging", keyBytes)).not.toThrow();
    expect(readStore(file, "staging", keyBytes)).toEqual({});
  });

  it("the bypass fixture never unroutes: the write fence on the same context stays active until the context closes", async () => {
    const routes: string[] = [];
    let unrouted = 0;
    const context = {
      route: async (_p: string, _h: unknown) => void routes.push("registered"),
      unrouteAll: async () => void (unrouted += 1),
    };
    let during = -1;
    await withBypass(context as never, STAGING, BYPASS_VALUE, async () => {
      during = routes.length;
    });
    expect(during).toBe(1);
    expect(unrouted).toBe(0);
  });
});

describe("what the capture command prints about a failure it did not raise itself", () => {
  it("never prints the error text of a Playwright failure, only a fixed line and the class name", async () => {
    const { io, out, err } = setup();
    const launcher: Launcher = async () => ({
      cookie: async () => Promise.reject(new TargetClosedError(playwrightMessage("page.cookies: Target page, context or browser has been closed"))),
      close: async () => undefined,
    });
    expect(await main(argv, { ...io, launcher })).toBe(1);
    expectNoSentinel([...out, ...err]);
    expect(err.join("\n")).toContain("capture-session: failed unexpectedly (TargetClosedError)");
  });

  it("a launch failure is reduced the same way, and a non-Error throw prints the generic class", async () => {
    const { io, out, err } = setup();
    const launch: Launcher = async () => Promise.reject(new Error(playwrightMessage("browserType.launch failed")));
    expect(await main(argv, { ...io, launcher: launch })).toBe(1);
    const thrown: Launcher = async () => Promise.reject(playwrightMessage("a thrown string"));
    expect(await main(argv, { ...io, launcher: thrown })).toBe(1);
    expectNoSentinel([...out, ...err]);
    expect(err.filter((l) => l.startsWith("capture-session:"))).toHaveLength(2);
  });

  it("the unhandled-rejection guard prints a fixed line with the class name and asks the capture to end", () => {
    const lines: string[] = [];
    let aborted = 0;
    const guard = guardRejections("capture-session", (l) => lines.push(l), () => void (aborted += 1));
    guard.handler(new TargetClosedError(playwrightMessage("route.fetch: Request context disposed.")));
    guard.handler("a bare string rejection " + BYPASS_VALUE);
    guard.dispose();
    expect(aborted).toBe(2);
    expect(lines).toHaveLength(2);
    expectNoSentinel(lines);
    expect(lines[0]).toContain("(TargetClosedError)");
    expect(lines[1]).toContain("(Error)");
  });

  it("the guard is installed for the command and removed after it", async () => {
    const { io } = setup();
    const before = process.listenerCount("unhandledRejection");
    let during = -1;
    const launcher: Launcher = async () => {
      during = process.listenerCount("unhandledRejection");
      return { cookie: async () => COOKIE, close: async () => undefined };
    };
    expect(await main(argv, { ...io, launcher })).toBe(0);
    expect(during).toBe(before + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });

  it("an error class name is a plain identifier or the generic Error", () => {
    class Ok extends Error {}
    expect(errorClassName(new Ok("x"))).toBe("Ok");
    expect(errorClassName("text")).toBe("Error");
    expect(errorClassName(Object.assign(new Error("x"), { constructor: { name: `bad name ${BYPASS_VALUE}` } }))).toBe("Error");
  });
});
