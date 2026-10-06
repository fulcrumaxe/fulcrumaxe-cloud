import { reportError } from "@fx/telemetry";

/**
 * Keeps the serverless invocation that started a run alive while its stream is read and finalized.
 *
 * Vercel freezes (and later ends) an invocation as soon as its response is done, whatever promises are still pending in
 * it; `waitUntil` is the platform's way to say "stay alive until this settles", up to the function's `maxDuration`
 * (800 s for the workflow routes). The platform exposes it on the request context under `Symbol.for("@vercel/request-context")`
 * (what `@vercel/functions` and `@vercel/oidc` read; this reads the same slot). Off Vercel (tests, `next dev`, a long-lived
 * server) there is no such slot and the work simply runs on, which is correct there and stays quiet.
 *
 * On Vercel a missing slot, a missing `get` or a context without `waitUntil` is NOT quiet: the stream would be dropped at
 * the freeze and the run would sit in `running` with nothing in the logs. It is reported with a fixed code (stdout line and
 * the error-class reporter). The check is made on every call, so it is also loud if the platform ever changes the slot.
 *
 * This only extends the invocation's life. It is not what starts the agent: the sandbox target awaits the launch itself
 * before `dispatch` returns, so a launch never depends on this hook.
 */
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

type RequestContext = { waitUntil?: (work: Promise<unknown>) => void };

export interface KeepAliveDeps {
  /** The process environment; `VERCEL` set means a missing `waitUntil` is a fault. */
  env?: Readonly<Record<string, string | undefined>>;
  report?: (err: unknown, ctx: { stage: string }) => void;
  warn?: (line: string) => void;
}

/** `keepAlive(work)` for the sandbox target. `waitUntil` is `@vercel/functions`' (apps/web passes it; this package takes no dependency on it); `holder` is `globalThis` in production and a stand-in in tests. */
export function createVercelKeepAlive(
  waitUntil: (work: Promise<unknown>) => void | undefined,
  holder: object = globalThis,
  deps: KeepAliveDeps = {},
): (work: Promise<unknown>) => void {
  const env = deps.env ?? process.env;
  const report = deps.report ?? reportError;
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  return (work) => {
    // The library's `waitUntil` does nothing, silently, when the platform gave this invocation no context; the slot is read
    // only to know whether it will do anything.
    const slot = (holder as Record<symbol, { get?: () => RequestContext | undefined } | undefined>)[REQUEST_CONTEXT];
    if (typeof slot?.get?.()?.waitUntil === "function") {
      waitUntil(work);
      return;
    }
    if (env.VERCEL) {
      warn(JSON.stringify({ event: "run.keep_alive_unavailable" }));
      report(new Error("keep-alive unavailable"), { stage: "run.keep_alive" });
    }
  };
}

/** The platform's own `waitUntil` for this invocation (the request-context slot), or nothing when there is none. The default when a builder gives no override. */
export function slotWaitUntil(work: Promise<unknown>): void {
  const slot = (globalThis as Record<symbol, { get?: () => RequestContext | undefined } | undefined>)[REQUEST_CONTEXT];
  slot?.get?.()?.waitUntil?.(work);
}
