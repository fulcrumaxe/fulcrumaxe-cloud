# @fx/telemetry

The redacting logger: one JSON line per event on stdout, no vendor SDK, no network.

## A line carries no free text

Redaction knows the shape of a secret, not of an arbitrary prompt, file or customer value, so a payload
that someone serialised into a string would reach stdout. The logger therefore accepts no such string.

```ts
import { createLogger } from "@fx/telemetry";

const log = createLogger({ service: "api" });
log.error("run.settle.failed", { run_id, status: 502, error: err });
```

- **`event`** is a code from the registry in `src/events.ts` (`/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,4}$/`).
  Add yours there in the PR that first logs it. A value outside the registry is not emitted; the line says
  `telemetry.invalid_event`.
- **Fields are typed.** Ids are UUIDs (`trace_id` also a 32-hex W3C id), `status`/`duration_ms`/`count` are finite
  numbers, `error_code` is on the code allowlist (`src/errorCodes.ts`: our own codes, SQLSTATE, Node `ERR_*`, errno, known Stripe codes), `stage` is a lowercase label, and `route` is reduced to a template (no query or
  fragment; any segment not in `ROUTE_LITERALS` becomes `:id`). A value that fails is dropped, not coerced.
- **Errors are passed as objects** under `error`. The line gets `error_name` (the class name) and `error_code`
  (the error's `code`, if valid). Its message and stack are never emitted, because a message can quote input.
  A class may declare its own `static fixedMessage = "<literal>"`, which is emitted instead of the error's message (a subclass inherits nothing; the static is read only off the error's direct constructor, and `error.message` is never read).
- Every string that is still emitted passes `redactDeep` and a 2,048-character cap.

## Lint

`eslint.config.mjs` forbids, inside a call to `log.` or `logger.` `info|warn|error` (those binding names; use
one of them), a template literal with expressions, a `+` with a string operand, and `JSON.stringify`. These
are the ways to build text at the call site. The package's own tests are exempt.

## Reporting a caught error

`reportError(err, { stage, route, code? })` (`src/reportError.ts`) is the one way to report a caught server
error. It writes one `error.reported` line (stage, route template, `error_name`, `error_code`) and hands the
error CLASS (service, route template, stage, code) to the installed `ErrorSink`. The message and stack never
leave. A code that is not on the allowlist is reported as `other`; a stage or service outside
`^[a-z][a-z0-9_.]{0,39}$` is replaced, never echoed. The package does no I/O for storage: the web app installs
the Postgres sink from `@fx/db` once in `apps/web/instrumentation.ts`.

The `fx-catch/no-silent-catch` lint rule (`lint/no-silent-catch.mjs`) asks every server `catch` to rethrow, call
`reportError` or a logger's `error`/`warn`, or say `// fx-swallow-ok: <reason>`.
