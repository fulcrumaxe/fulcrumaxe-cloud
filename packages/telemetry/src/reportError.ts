import { errorCodeOrOther, safeLabel } from "./errorCodes.js";
import { routeTemplate } from "./fields.js";
import { createLogger, type Logger } from "./logger.js";

/**
 * One reporter for a caught server error. It has no I/O of its own beyond the stdout line the logger writes:
 * the place that stores error classes is an `ErrorSink` the app installs at start-up (the Postgres one lives
 * in @fx/db). What leaves this function is a CLASS -- service, route template, stage, code -- never the
 * error's message, stack, or any upstream text, so there is nothing in it for a token or a name to ride on.
 */

/** A class of error: the four coded labels, each already validated. The sink stores a count per class. */
export interface ErrorClass {
  service: string;
  route: string;
  stage: string;
  code: string;
}

/** Where error classes go. `record` must return quickly and must not throw; a failure inside it is swallowed by the reporter. */
export interface ErrorSink {
  record(event: ErrorClass): void;
}

export interface ReportContext {
  /** Where in the work it failed; a lowercase label (`^[a-z][a-z0-9_.]{0,39}$`), else replaced by `unknown`. */
  stage: string;
  /** The request path; reduced to its template. Absent or not a path: `/`. */
  route?: string;
  /** Overrides the error's own code. Still passes the allowlist, else `other`. */
  code?: string;
}

export interface ErrorReporterOptions {
  service: string;
  sink?: ErrorSink | undefined;
  /** Where the stdout line goes. Defaults to stdout. */
  write?: (line: string) => void;
  now?: () => number;
}

export interface ErrorReporter {
  reportError(err: unknown, ctx: ReportContext): void;
}

/** The error's own `code`, read defensively: a throwing getter costs the code, never the report. */
function ownCode(err: unknown): unknown {
  try {
    return err !== null && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  } catch {
    // fx-swallow-ok: a throwing code getter costs the code only; the report goes ahead with `other`
    return undefined;
  }
}

export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  const service = safeLabel(options.service, "app");
  const logger: Logger = createLogger({
    service,
    ...(options.write ? { write: options.write } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  let inSink = false;

  function reportError(err: unknown, ctx: ReportContext): void {
    try {
      const stage = safeLabel(ctx.stage, "unknown");
      const route = routeTemplate(ctx.route) ?? "/";
      const code = errorCodeOrOther(ctx.code !== undefined ? ctx.code : ownCode(err));
      // The stdout line first: it stands whatever the sink does.
      logger.error("error.reported", { route, stage, error: err, error_code: code });
      const sink = options.sink;
      // A sink that reports its own failure through here must not recurse into itself.
      if (sink && !inSink) {
        inSink = true;
        try {
          const pending: unknown = sink.record({ service, route, stage, code });
          if (pending && typeof (pending as { then?: unknown }).then === "function") {
            (pending as Promise<unknown>).then(undefined, () => undefined);
          }
        } finally {
          inSink = false;
        }
      }
    } catch {
      // fx-swallow-ok: a reporter that throws would turn one failure into two; reporting never changes the caller's flow
    }
  }

  return { reportError };
}

// The process-wide reporter. The web app configures it once (instrumentation.ts); until then it logs to
// stdout only, as service `app`.
let current: ErrorReporter = createErrorReporter({ service: "app" });

export function configureErrorReporter(options: ErrorReporterOptions): void {
  current = createErrorReporter(options);
}

export function reportError(err: unknown, ctx: ReportContext): void {
  current.reportError(err, ctx);
}
