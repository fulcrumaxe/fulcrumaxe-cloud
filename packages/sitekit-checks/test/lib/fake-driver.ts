import type { BrowserDriver, BrowserPage, JsonValue } from "../../src/lib/browser/driver.js";

/** A scriptable in-memory driver for the default (no-browser) test tier. */
export interface FakeDriver extends BrowserDriver {
  closed: number;
  evaluated: { script: string; arg?: JsonValue }[];
}

export function fakeDriver(opts: { openError?: Error; evaluate?: (script: string) => unknown; hang?: boolean } = {}): FakeDriver {
  const driver: FakeDriver = {
    closed: 0,
    evaluated: [],
    async open(): Promise<BrowserPage> {
      if (opts.openError) throw opts.openError;
      return {
        goto: async () => {},
        setViewport: async () => {},
        emulateMedia: async () => {},
        blockUrls: async () => {},
        evaluate: async (script, arg) => {
          driver.evaluated.push({ script, arg });
          if (opts.hang) return new Promise(() => {});
          return opts.evaluate ? opts.evaluate(script) : null;
        },
        securityMessages: () => [],
        blockedRequests: () => 0,
        close: async () => {},
      };
    },
    async close() {
      driver.closed++;
    },
  };
  return driver;
}
