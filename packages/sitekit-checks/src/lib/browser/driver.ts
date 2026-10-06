/**
 * The seam between browser checks and a real browser. Types only: no runtime
 * import, so nothing in `src/` can pull a browser into the runtime graph.
 * The test adapter is in test/browser/; the production
 * adapter (K12c) lives in packages/browser.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface BrowserPage {
  goto(url: string): Promise<void>;
  setViewport(v: { width: number; height: number; mobile: boolean }): Promise<void>;
  emulateMedia(m: { reducedMotion?: "reduce" | "no-preference"; colorScheme?: "light" | "dark" }): Promise<void>;
  /** Abort same-origin requests whose path matches a glob (`*` matches any run of characters). */
  blockUrls(patterns: string[]): Promise<void>;
  /** `script` is a constant function expression, e.g. `(arg) => ...`. Data goes in `arg`, passed as a serialised argument. */
  evaluate(script: string, arg?: JsonValue): Promise<unknown>;
  /** Console messages the browser raised about security (CSP, mixed content, blocked loads). */
  securityMessages(): string[];
  /** How many requests the adapter aborted for leaving the served origin. */
  blockedRequests(): number;
  close(): Promise<void>;
}

export interface BrowserDriver {
  open(): Promise<BrowserPage>;
  close(): Promise<void>;
}
