import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedEvent } from "../../src/types.js";

/**
 * D#221 R1b: the backend conformance suite. Every backend (D#221 R2, R3) is run through `conformanceViolations` in its
 * own PR, over its own recorded fixtures, with a driver that runs the REAL port (not a copy of its rules). The suite
 * says what must hold whatever the agent CLI prints; it knows no CLI's line format. Fixtures carry that, per backend:
 * `test/fixtures/backends/<name>/`.
 *
 * Rules, by the names the Spec uses:
 *  EV-MAP     the fixture's lines map to the events its `clean.expected.json` lists, and nothing is reported invalid.
 *  EV-ID      runId, role, seq and backend are the runner's, whatever a line says about them.
 *  EV-SETTLE  a run settles max(metered, the final valid reported figure, 0): a reported figure never lowers it.
 *  MP-MSG     a line that carries usage but no message id never reaches the meter.
 *  MP-SRC     usage and completion come only from the command's stdout and exit, never its stderr.
 *  MP-PLAUS   one line cannot raise the metered total by more than the per-line ceiling, and is flagged.
 *  EXIT       exit 0 with no terminal line is a failure, and a terminal line followed by a bad exit is too.
 *
 * Mutation proofs: `packages/runner/test/backends/claudeCode.conformance.test.ts` runs the suite against copies of the
 * real driver with one rule broken each, and fails unless every one is caught under its own rule. The proofs that
 * matter more are on the real code (the four #259 mutations: per-line sum, a lower figure lowering the meter, usage
 * read from stderr, an unpriced model not refused); the PR that adds a backend lists them with the tests they turn red.
 */

export const CONFORMANCE_RUN_ID = "run-1";
export const CONFORMANCE_ROLE = "reviewer";
/** The per-line ceiling on the input side of one line's usage (tokens); a line above it is implausible. */
export const CONFORMANCE_LINE_CEILING = 1_000_000;

export interface ConformanceIo {
  stdout: string[];
  stderr?: string[];
  exit: number;
}

export interface ConformanceRun {
  /** Every event the port delivered, in order. */
  delivered: NormalizedEvent[];
  /** The reasons the port dropped a line, in order. */
  invalid: string[];
  /** The event that ended the run (what the hook fired with). */
  last: NormalizedEvent | undefined;
}

export interface ConformanceDriver {
  /** The backend's registered name. */
  backend: string;
  /** Runs one agent command to its end through the real port, as run `CONFORMANCE_RUN_ID` with role `CONFORMANCE_ROLE`. */
  run(io: ConformanceIo): Promise<ConformanceRun>;
  /** The runner's meter over delivered events: the total input side (tokens) and whether it called the run implausible. */
  meter(events: NormalizedEvent[]): { total: MeteredTotal; inputSideTokens: number; implausible: boolean; flags: string[] };
  /** What a run settles at: the runner's own settlement over the final event and the metered figure. */
  settle(last: NormalizedEvent | undefined, meteredUsd: number): { status: string; usd: number | undefined };
}

export interface MeteredTotal {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export interface CleanExpectation {
  /** What the runner's meter reaches over the clean run's events. */
  meteredTotal: MeteredTotal;
  /** The per-id run: each id's per-field maximum, summed. */
  perId: { meteredTotal: MeteredTotal };
  types: string[];
  messageIds: (string | null)[];
  sessionId: string;
  toolUses: unknown[];
  agentOutput: Record<string, unknown>;
  costUsd: number;
}

export interface ConformanceFixtures {
  clean: string[];
  cleanExpected: CleanExpectation;
  forgedIdentity: string[];
  idlessUsage: string[];
  inflatedUsage: string[];
  noTerminal: string[];
  /** One message id repeated across lines, with a later line that reports a lower figure than an earlier one. */
  perId: string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const lines = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter((l) => l !== "");

/** Loads `test/fixtures/backends/<name>/`. */
export function loadConformanceFixtures(name: string): ConformanceFixtures {
  const dir = path.join(here, "..", "fixtures", "backends", name);
  return {
    clean: lines(path.join(dir, "clean.jsonl")),
    cleanExpected: JSON.parse(readFileSync(path.join(dir, "clean.expected.json"), "utf8")) as CleanExpectation,
    forgedIdentity: lines(path.join(dir, "forged-identity.jsonl")),
    idlessUsage: lines(path.join(dir, "idless-usage.jsonl")),
    inflatedUsage: lines(path.join(dir, "inflated-usage.jsonl")),
    noTerminal: lines(path.join(dir, "no-terminal.jsonl")),
    perId: lines(path.join(dir, "per-id.jsonl")),
  };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The contract's violations for one backend, each starting with its rule name (empty when it conforms). */
export async function conformanceViolations(driver: ConformanceDriver, fx: ConformanceFixtures): Promise<string[]> {
  const bad: string[] = [];
  const clean = await driver.run({ stdout: fx.clean, exit: 0 });

  // EV-MAP
  const want = fx.cleanExpected;
  if (!same(clean.delivered.map((e) => e.type), want.types)) bad.push("EV-MAP: event types differ from the fixture's expectation");
  if (!same(clean.delivered.map((e) => e.messageId ?? null), want.messageIds)) bad.push("EV-MAP: message ids differ");
  if (!clean.delivered.every((e) => e.sessionId === undefined || e.sessionId === want.sessionId)) bad.push("EV-MAP: session id differs");
  if (!same(clean.delivered.flatMap((e) => e.toolUses ?? []), want.toolUses)) bad.push("EV-MAP: tool uses differ");
  if (!same(clean.last?.agentOutput, want.agentOutput) || clean.last?.type !== "result") bad.push("EV-MAP: the final result or its envelope differs");
  if (clean.last?.costUsd !== want.costUsd) bad.push("EV-MAP: the reported cost differs");
  if (clean.invalid.length > 0) bad.push("EV-MAP: a clean run reported an invalid line");

  // EV-ID
  const forged = await driver.run({ stdout: fx.forgedIdentity, exit: 0 });
  const identityOk = forged.delivered.length > 0 && forged.delivered.every((e, i) =>
    e.runId === CONFORMANCE_RUN_ID && e.role === CONFORMANCE_ROLE && e.seq === i && e.backend === driver.backend && e.ts > "2020",
  );
  if (!identityOk) bad.push("EV-ID: an event carries an identity (run, role, seq, ts or backend) that is not the runner's");
  if (!clean.delivered.every((e) => e.backend === driver.backend)) bad.push("EV-ID: an event is not stamped with the backend");

  // EV-SETTLE
  const settledLow = driver.settle(clean.last, 1.0);
  if (settledLow.usd !== 1.0) bad.push("EV-SETTLE: a reported figure below the metered total lowered the settled one");
  const settledHigh = driver.settle(clean.last, 0.1);
  if (settledHigh.usd !== want.costUsd) bad.push("EV-SETTLE: a valid reported figure above the metered total was not settled");
  if (driver.settle(undefined, 0).usd !== undefined) bad.push("EV-SETTLE: a run that metered nothing and reported nothing settled a figure");

  // MP-MSG
  const idless = await driver.run({ stdout: fx.idlessUsage, exit: 0 });
  if (idless.delivered.some((e) => e.usage !== undefined && e.messageId === undefined)) bad.push("MP-MSG: a usage line with no message id reached the meter");
  if (!idless.delivered.some((e) => e.messageId !== undefined)) bad.push("MP-MSG: the line with an id was dropped with the one without");

  if (!same(driver.meter(clean.delivered).total, want.meteredTotal)) bad.push("MP-MSG: the metered total over a clean run is not the expected one");
  const perId = await driver.run({ stdout: fx.perId, exit: 0 });
  if (!same(driver.meter(perId.delivered).total, want.perId.meteredTotal)) {
    bad.push("MP-MSG: the meter is not each message id's per-field maximum, summed (repeated lines summed, or a lower figure lowered it)");
  }

  // MP-SRC
  const err = await driver.run({ stdout: [], stderr: fx.clean, exit: 0 });
  if (err.delivered.length > 0) bad.push("MP-SRC: a line on stderr became an event");
  if (err.last?.type !== "error") bad.push("MP-SRC: a run whose stdout was empty did not fail");

  // MP-PLAUS
  const inflated = await driver.run({ stdout: fx.inflatedUsage, exit: 0 });
  const meter = driver.meter(inflated.delivered);
  if (!meter.implausible || meter.flags.length === 0) bad.push("MP-PLAUS: a line above the ceiling was not called implausible");
  if (meter.inputSideTokens > fx.inflatedUsage.length * CONFORMANCE_LINE_CEILING) bad.push("MP-PLAUS: one line raised the metered total above the ceiling");

  // EXIT
  const noTerminal = await driver.run({ stdout: fx.noTerminal, exit: 0 });
  if (noTerminal.last?.type !== "error" || noTerminal.last.isError !== true) bad.push("EXIT: exit 0 with no terminal line did not fail");
  const badExit = await driver.run({ stdout: fx.clean, exit: 1 });
  if (badExit.last?.type !== "error") bad.push("EXIT: a terminal result followed by a failing exit did not fail");
  return bad;
}
