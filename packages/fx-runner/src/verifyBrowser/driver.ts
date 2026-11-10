import { existsSync, promises as fs, readdirSync } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { LoginSession } from "../commands/verifyLogin.js";
import { signedInAs } from "./identity.js";
import { loadPlaywright } from "./loadPlaywright.js";
import { readScopedState } from "./stateScope.js";
import { hostRulesArg, isAllowedUrl, type BasePin } from "./pin.js";
import { startOriginProxy, type OriginProxy } from "./proxy.js";
import { SNAPSHOT_SCRIPT, type RawElement } from "./snapshot.js";

/**
 * D#749 V2c-2a: the one place a browser is started. Chromium comes from the runner's settings (the browsers directory first, then the system's Chrome or
 * Chromium), never from a running Chrome of the person's. Every job gets a fresh browser and a context built from the storage-state file it is given: `readScopedState` (stateScope.ts)
 * reads it once, refuses it when it holds another origin, and hands the checked object to the context; it is never logged and nothing is written back to it. The browser's environment is a short allowlist plus a throwaway HOME
 * and TMPDIR inside the job directory, so no token of the runner's reaches it. Playwright puts the browser's profile in a fresh temp directory of its own and removes
 * it when the browser closes; the job's HOME and TMPDIR are removed by `close` below.
 */
export const ACTION_MS = 10_000;
export const NAVIGATION_MS = 30_000;
const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TZ", "FONTCONFIG_FILE", "FONTCONFIG_PATH"];
const KEYS = new Set(["Enter", "Escape", "Tab"]);
const REF = /^e[1-9]\d{0,3}$/;
/** No window.open, target=_blank link or form target opens a page: a second page would have no redirect check of its own. */
export const NO_POPUPS_FLAG = "--block-new-web-contents";
/** Loopback goes through the proxy too (the browser would otherwise bypass it for 127.0.0.1, localhost and ::1). */
export const PROXY_BYPASS_FLAG = "--proxy-bypass-list=<-loopback>";
export const WEBRTC_FLAG = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
/** Runs in every frame before the page's own script: WebRTC cannot be constructed. */
const NO_WEBRTC_SCRIPT = "for (const n of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) Object.defineProperty(window, n, { value: undefined, configurable: false, writable: false });";

/** A refusal with a closed code. The message is the code: nothing a page said is ever in it. */
export class ToolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ToolError";
  }
}

export interface PageDriver {
  go(url: string): Promise<void>;
  url(): string;
  scan(): Promise<{ elements: RawElement[]; text: string }>;
  click(ref: string): Promise<void>;
  fill(ref: string, text: string): Promise<void>;
  choose(ref: string, option: string): Promise<void>;
  press(key: string): Promise<void>;
  reload(): Promise<void>;
  waitText(text: string, ms: number): Promise<boolean>;
  textOf(ref: string): Promise<string>;
  /** Requests the route refused: all of them, and the ones that were page navigations. */
  blocked(): { requests: number; navigations: number };
  /** The GitHub login the saved session is signed in as, from the app's own identity route (identity.ts), or undefined when the lookup gives nothing usable. Never throws. */
  identity(): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface DriverConfig {
  base: BasePin;
  executablePath: string;
  jobDir: string;
  /** Path of a Playwright storage-state file; read once and checked by stateScope.ts before anything starts. */
  storageStatePath?: string | undefined;
  hostEnv: Readonly<Record<string, string | undefined>>;
  /** Tests only: accept the self-signed certificate of a local https server. Nothing in production sets it. */
  ignoreHttpsErrors?: boolean | undefined;
  onConsole(type: string, text: string): void;
}

/** The Chromium to run: the browsers directory named by PLAYWRIGHT_BROWSERS_PATH first (headless shell, then full Chromium), then Chrome or Chromium on PATH. */
export function findChromium(env: Readonly<Record<string, string | undefined>>, opts: { headed?: boolean } = {}): string | undefined {
  const dirs = (root: string, prefix: string): string[] => {
    try {
      return readdirSync(root).filter((n) => n.startsWith(prefix)).sort().reverse().map((n) => path.join(root, n));
    } catch {
      // fx-swallow-ok: an unreadable browsers directory means there is no browser there
      return [];
    }
  };
  const browsers = env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsers !== undefined && path.isAbsolute(browsers)) {
    // The headless shell has no window, so the sign-in step (`verify-login`) skips it.
    for (const [prefix, sub, bin] of [["chromium_headless_shell-", "chrome-headless-shell", "chrome-headless-shell"], ["chromium-", "chrome-linux", "chrome"]] as const) {
      if (opts.headed === true && prefix.includes("headless")) continue;
      for (const dir of dirs(browsers, prefix)) {
        for (const inner of dirs(dir, sub)) if (existsSync(path.join(inner, bin))) return path.join(inner, bin);
      }
    }
  }
  for (const dir of (env.PATH ?? "").split(":").filter((d) => path.isAbsolute(d))) {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) if (existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return undefined;
}

function classify(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  const text = error instanceof Error ? error.message : "";
  if (/Download is starting/i.test(text)) return new ToolError("download_refused");
  if (/Timeout/i.test(text)) return new ToolError("timeout");
  return new ToolError("action_failed");
}

export async function launchDriver(cfg: DriverConfig): Promise<PageDriver> {
  const info = await fs.lstat(cfg.jobDir);
  if (!path.isAbsolute(cfg.jobDir) || !info.isDirectory() || info.isSymbolicLink()) throw new ToolError("bad_job_dir");
  // The saved sign-in is read once, here, and refused when it holds anything of another origin (an older or hand-written file could carry a GitHub session); the browser is given
  // the checked object, never the path again. Nothing is started before this passes.
  let scoped: Exclude<NonNullable<NonNullable<Parameters<Browser["newContext"]>[0]>["storageState"]>, string> | undefined;
  if (cfg.storageStatePath !== undefined) {
    const read = readScopedState(cfg.storageStatePath, cfg.base);
    if (!read.ok) throw new ToolError(read.code);
    scoped = read.state as typeof scoped;
  }
  const home = path.join(cfg.jobDir, "home");
  const tmp = path.join(cfg.jobDir, "tmp");
  // A plain mkdir (not recursive): a path that already exists, a planted link included, is refused rather than reused or removed.
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(tmp, { mode: 0o700 });
  const env: Record<string, string> = { HOME: home, TMPDIR: tmp };
  for (const name of ENV_ALLOWLIST) {
    const value = cfg.hostEnv[name];
    if (value !== undefined) env[name] = value;
  }
  let pw: typeof import("playwright-core");
  try {
    pw = (await loadPlaywright()) as typeof import("playwright-core");
  } catch {
    // fx-swallow-ok: reported as a closed code; the loader's message names paths
    throw new ToolError("playwright_missing");
  }
  let browser: Browser | undefined;
  let proxy: OriginProxy | undefined;
  try {
    // The network layer comes first: the browser's only way out is a local proxy that passes the exact base origin and nothing else, loopback included (the bypass list
    // is overridden, or the browser would reach loopback addresses directly). It holds even for what the page-level hooks below never see, such as the browser's own
    // prefetch and prerender.
    proxy = await startOriginProxy(cfg.base);
    // The Chromium sandbox stays on (never --no-sandbox). SharedWorker requests bypass the route, so they are off. Every host but the base host fails to resolve.
    // WebRTC would let page script send UDP to any host (a TURN or STUN server, the local network, a metadata address) past every layer below, so it gets no
    // non-proxied UDP and the constructors are removed from each page.
    browser = await pw.chromium.launch({ executablePath: cfg.executablePath, headless: true, chromiumSandbox: true, env, args: ["--disable-shared-workers", NO_POPUPS_FLAG, `--proxy-server=http://127.0.0.1:${proxy.port}`, PROXY_BYPASS_FLAG, hostRulesArg(cfg.base), WEBRTC_FLAG], timeout: NAVIGATION_MS });
    const context: BrowserContext = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      permissions: [],
      ...(cfg.ignoreHttpsErrors === true ? { ignoreHTTPSErrors: true } : {}),
      ...(scoped === undefined ? {} : { storageState: scoped }),
    });
    context.setDefaultTimeout(ACTION_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_MS);
    let blockedRequests = 0;
    let blockedNavigations = 0;
    const recordBlocked = (pageLoad: boolean): void => {
      blockedRequests += 1;
      if (pageLoad) blockedNavigations += 1;
    };
    await context.addInitScript(NO_WEBRTC_SCRIPT);
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (isAllowedUrl(request.url(), cfg.base)) return route.continue();
      recordBlocked(request.isNavigationRequest());
      return route.abort("blockedbyclient");
    });
    // A WebSocket is not a request the route sees. Its address is judged here as the http(s) origin it would be, and nothing else is connected.
    await context.routeWebSocket(/.*/, (socket) => {
      if (isAllowedUrl(socket.url().replace(/^ws/, "http"), cfg.base)) return void socket.connectToServer();
      recordBlocked(false);
      return void socket.close();
    });
    const page: Page = await context.newPage();
    // Second layer behind the flag: any other page is closed at once, and every tool acts on this first page only.
    context.on("page", (other) => {
      if (other !== page) void other.close().catch(() => undefined);
    });
    // The browser follows a redirect without asking the route again, and the host rules cannot tell two ports of one host apart. So every response is paused at the
    // response stage, before any body is read, and a redirect is judged from its status and Location header alone: one to another origin fails the request, and the
    // browser never makes it. No body passes through this process.
    const cdp = await context.newCDPSession(page);
    cdp.on("Fetch.requestPaused", (e) => {
      const location = e.responseHeaders?.find((h) => h.name.toLowerCase() === "location")?.value;
      const redirect = (e.responseStatusCode ?? 0) >= 300 && (e.responseStatusCode ?? 0) < 400 && location !== undefined;
      let allowed = true;
      if (redirect) {
        try {
          allowed = isAllowedUrl(new URL(location, e.request.url).href, cfg.base);
        } catch {
          // fx-swallow-ok: a Location that does not parse leads nowhere allowed
          allowed = false;
        }
      }
      if (!allowed) recordBlocked(e.resourceType === "Document");
      const answer = allowed ? cdp.send("Fetch.continueResponse", { requestId: e.requestId }) : cdp.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" });
      answer.catch(() => undefined);
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Response" }] });
    page.on("console", (m) => cfg.onConsole(m.type(), m.text()));
    page.on("pageerror", (e) => cfg.onConsole("error", e.message));
    // The ref comes from the model, so it is checked against a fixed shape before it is used; it is never a selector of the model's making.
    const target = async (ref: string) => {
      if (!REF.test(ref)) throw new ToolError("stale_ref");
      const loc = page.locator(`[data-fx-ref="${ref}"]`);
      if ((await loc.count()) !== 1) throw new ToolError("stale_ref");
      return loc;
    };
    const guard = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        throw classify(error);
      }
    };
    return {
      go: (url) => guard(async () => void (await page.goto(url, { waitUntil: "domcontentloaded" }))),
      url: () => page.url(),
      scan: () => guard(() => page.evaluate(SNAPSHOT_SCRIPT) as Promise<{ elements: RawElement[]; text: string }>),
      click: (ref) =>
        guard(async () => {
          const loc = await target(ref);
          const kind = await loc.evaluate((el) => ({ type: el.getAttribute("type") ?? "", download: el.hasAttribute("download") }));
          if (kind.download || kind.type.toLowerCase() === "file") throw new ToolError("refused_element");
          await loc.click();
        }),
      fill: (ref, text) =>
        guard(async () => {
          const loc = await target(ref);
          const kind = await loc.evaluate((el) => ({ tag: el.tagName.toLowerCase(), type: (el.getAttribute("type") ?? "text").toLowerCase() }));
          const ok = kind.tag === "textarea" || (kind.tag === "input" && !["password", "file", "hidden"].includes(kind.type));
          if (!ok) throw new ToolError("refused_element");
          await loc.fill(text);
        }),
      choose: (ref, option) =>
        guard(async () => {
          await (await target(ref)).selectOption({ label: option });
        }),
      press: (key) =>
        guard(async () => {
          if (!KEYS.has(key)) throw new ToolError("refused_key");
          await page.keyboard.press(key);
        }),
      reload: () => guard(async () => void (await page.reload({ waitUntil: "domcontentloaded" }))),
      waitText: async (text, ms) => {
        try {
          await page.getByText(text).first().waitFor({ state: "visible", timeout: Math.min(ms, ACTION_MS) });
          return true;
        } catch {
          // fx-swallow-ok: text that did not appear in time is the answer false, not a failure
          return false;
        }
      },
      textOf: (ref) => guard(async () => (await target(ref)).innerText()),
      blocked: () => ({ requests: blockedRequests + (proxy?.refused() ?? 0), navigations: blockedNavigations }),
      // One GET with no redirect followed and a short time limit; the context's request API carries the saved session's cookies.
      identity: () => signedInAs((url) => context.request.get(url, { maxRedirects: 0, timeout: ACTION_MS, failOnStatusCode: false, headers: { accept: "application/json" } }), cfg.base),
      close: async () => {
        await browser?.close().catch(() => undefined);
        await proxy?.close();
        await fs.rm(home, { recursive: true, force: true });
        await fs.rm(tmp, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await proxy?.close();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
    throw classify(error);
  }
}

/**
 * The headed browser of `fx-runner verify-login`. A fresh Chromium with a window and no saved state (Playwright keeps its profile in a temporary folder it removes on close), opened on the
 * app's sign-in address only. There is no origin pin here on purpose: the sign-in goes through the identity provider. The caller reads the state out of the context once, saves it at mode 0600
 * and never shows it.
 */
export async function openHeadedBrowser(executable: string, url: string): Promise<LoginSession> {
  let pw: typeof import("playwright-core");
  try {
    pw = (await loadPlaywright()) as typeof import("playwright-core");
  } catch {
    // fx-swallow-ok: reported as a closed code; the loader's message names paths
    throw new ToolError("playwright_missing");
  }
  const browser = await pw.chromium.launch({ executablePath: executable, headless: false, chromiumSandbox: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    return { storageState: () => context.storageState(), currentUrl: () => page.url(), close: () => browser.close() };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}
