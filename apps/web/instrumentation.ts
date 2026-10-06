/**
 * D#69 B5: refuse to start the server with an empty STRIPE_PRICE_ID_*.
 *
 * Also installs the process-wide error reporter once, at start-up. Every caught server error then writes one
 * coded stdout line, and, when the app_user login is configured, is counted as an error class in Postgres (the
 * `error_events` table, through the definer function; see packages/db/src/errorSink.ts).
 *
 * Everything is inside the `NEXT_RUNTIME === "nodejs"` branch ON PURPOSE: Next compiles this file for the edge
 * runtime too and removes that branch there. A helper function outside the branch would keep `pg` in the edge
 * bundle, and the build fails on its `fs` import.
 *
 * The first occurrence of a class is handed to Next's `after()`, so a function frozen right after its response
 * still records it. `after()` only works inside a request; anywhere else (a timer, start-up) it throws, and the
 * write then simply runs unscheduled. The pool holds one connection at most and connects only when a first error
 * is reported. Without DATABASE_URL_APP_USER (already a required setting) there is no sink and reports are
 * stdout-only.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertStripePriceIdsConfigured } = await import("@fx/billing");
    assertStripePriceIdsConfigured();
    // D#454 H3c: the no-database "work pending" marker the sweep crons read before they connect. This must stay
    // BEFORE the error-reporter block below, which returns early when DATABASE_URL_APP_USER is unset.
    const { installPendingWork } = await import("./lib/pendingWorkStore");
    installPendingWork();

    const { configureErrorReporter } = await import("@fx/telemetry");
    const url = process.env.DATABASE_URL_APP_USER;
    if (!url) {
      configureErrorReporter({ service: "web" });
      return;
    }
    const [{ createPool }, { createPgErrorSink }, { after }] = await Promise.all([
      import("@fx/db/src/pool.js"),
      import("@fx/db/src/errorSink.js"),
      import("next/server"),
    ]);
    const pool = createPool(url, { max: 1, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 3_000 });
    // An idle client that errors (a dropped connection) must not crash the process; the next write reconnects.
    pool.on("error", () => {
      // fx-swallow-ok: a dropped idle connection is replaced by the next write; reporting it from the sink's own pool could loop
    });
    const sink = createPgErrorSink({
      pool,
      schedule: (work) => {
        try {
          after(work);
        } catch {
          // fx-swallow-ok: outside a request there is no response to outlive; the write still runs, unscheduled
        }
      },
    });
    configureErrorReporter({ service: "web", sink });
  }
}
