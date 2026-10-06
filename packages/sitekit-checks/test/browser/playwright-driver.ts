import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "playwright-core";
import type { BrowserDriver, BrowserPage, JsonValue } from "../../src/lib/browser/driver.js";

/** Test-only adapter. The production adapter (K12c) lives in packages/browser. */
const ENV_ALLOWLIST = ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "FONTCONFIG_FILE", "FONTCONFIG_PATH"];
const SECURITY_RE = /content security policy|mixed content|refused to|blocked/i;

/** Child environment: the allowlist plus a throwaway HOME. Nothing else crosses over. */
export function buildChildEnv(src: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home };
  for (const key of ENV_ALLOWLIST) if (src[key] !== undefined) env[key] = src[key] as string;
  return env;
}

/** A SharedWorker's requests bypass `context.route`, so the browser must not run one. */
const SAFE_ARGS = ["--disable-shared-workers"];

/** Pipe transport (Playwright's default) and the Chromium sandbox left on. */
export function launchOptions(src: NodeJS.ProcessEnv, home: string): LaunchOptions {
  return { headless: true, chromiumSandbox: true, env: buildChildEnv(src, home), args: SAFE_ARGS };
}

function globToRegExp(glob: string): RegExp {
  return new RegExp("^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
}

export interface PlaywrightDriver extends BrowserDriver {
  /** The throwaway HOME of the running browser, or undefined when none is running. */
  homeDir(): string | undefined;
}

/**
 * `origin` is the serve.ts origin; every request to anywhere else is aborted and counted. A check starts its
 * own server, so with no `origin` each page is pinned to the loopback origin of its first `goto`.
 */
export function createPlaywrightDriver(origin?: string): PlaywrightDriver {
  let browser: Browser | undefined;
  let home: string | undefined;
  const contexts: BrowserContext[] = [];

  return {
    homeDir: () => home,
    async open(): Promise<BrowserPage> {
      if (!browser) {
        home = mkdtempSync(path.join(os.tmpdir(), "fx-browser-"));
        browser = await chromium.launch(launchOptions(process.env, home));
      }
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      contexts.push(context);
      const page: Page = await context.newPage();
      let allowed = origin;
      page.setDefaultNavigationTimeout(15_000);
      let blocked = 0;
      let blockedPaths: RegExp[] = [];
      const messages: string[] = [];

      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== allowed) {
          blocked++;
          return route.abort();
        }
        return blockedPaths.some((re) => re.test(url.pathname)) ? route.abort() : route.continue();
      });
      await context.routeWebSocket(/.*/, (ws) => {
        blocked++;
        void ws.close();
      });
      page.on("dialog", (d) => void d.dismiss());
      context.on("page", (p) => {
        if (p !== page) void p.close();
      });
      page.on("console", (m) => {
        if (m.type() === "error" && SECURITY_RE.test(m.text())) messages.push(m.text().slice(0, 200));
      });

      return {
        goto: async (url) => {
          const target = new URL(url);
          if (!allowed && target.hostname === "127.0.0.1") allowed = target.origin;
          const response = await page.goto(url, { waitUntil: "load" });
          if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
        },
        // Playwright fixes `isMobile` per context, so `mobile` only matters to a production adapter.
        setViewport: ({ width, height }) => page.setViewportSize({ width, height }),
        emulateMedia: (m) => page.emulateMedia({ reducedMotion: m.reducedMotion, colorScheme: m.colorScheme }),
        blockUrls: async (patterns) => {
          blockedPaths = patterns.map(globToRegExp);
        },
        // The script is a function expression; `arg` reaches it as a serialised argument, never as source text.
        evaluate: async (script: string, arg?: JsonValue) => {
          const fn = await page.evaluateHandle(script);
          try {
            return await fn.evaluate((f, a) => (f as (x: unknown) => unknown)(a), (arg ?? null) as unknown);
          } finally {
            await fn.dispose().catch(() => undefined);
          }
        },
        securityMessages: () => [...messages],
        blockedRequests: () => blocked,
        close: () => page.close(),
      };
    },
    async close() {
      const b = browser;
      const h = home;
      browser = undefined;
      home = undefined;
      await Promise.all(contexts.splice(0).map((c) => c.close().catch(() => undefined)));
      await b?.close().catch(() => undefined);
      if (h) await fs.rm(h, { recursive: true, force: true });
    },
  };
}
