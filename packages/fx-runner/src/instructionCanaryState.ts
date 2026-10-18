/**
 * D#601 MEM-7: what the last instruction-file check found, kept in the state directory so `fx-runner status` and the claim loop read one
 * answer. A pass is kept for the same binary path, version and argument list, so the model turn is spent once per build, not per start.
 * A failure is checked again at every start (the person may have fixed the install), and until then no job is claimed.
 */
import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { writePrivateFile } from "./config.js";

/** Why a check did not pass. `instruction_file_loaded` is the finding; the other is "could not tell", which also blocks claiming. */
export type InstructionCanaryReason = "instruction_file_loaded" | "instruction_canary_inconclusive";

export type InstructionCanaryResult = { ok: true } | { ok: false; reason: InstructionCanaryReason };

export const CANARY_STATE_FILE = "instruction-canary.json";

export interface CanaryState {
  status: "passed" | "blocked";
  reason?: InstructionCanaryReason;
  binary_path: string;
  binary_version: string | undefined;
  argv: string;
  checked_at: string;
}

const REASONS: readonly string[] = ["instruction_file_loaded", "instruction_canary_inconclusive"];

export function readCanaryState(stateDir: string): CanaryState | undefined {
  try {
    const file = path.join(stateDir, CANARY_STATE_FILE);
    if (!lstatSync(file).isFile()) return undefined;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CanaryState> | null;
    if (parsed === null || typeof parsed !== "object") return undefined;
    const fieldsOk = typeof parsed.binary_path === "string" && typeof parsed.argv === "string" && typeof parsed.checked_at === "string" && !Number.isNaN(Date.parse(parsed.checked_at)) && (parsed.binary_version === undefined || typeof parsed.binary_version === "string");
    if (!fieldsOk) return undefined;
    if (parsed.status === "passed") return parsed as CanaryState;
    if (parsed.status === "blocked" && typeof parsed.reason === "string" && REASONS.includes(parsed.reason)) return parsed as CanaryState;
    return undefined;
  } catch {
    // fx-swallow-ok: a missing or damaged file is "not checked yet"
    return undefined;
  }
}

/** The reason claiming is blocked, or undefined. Read before every claim; a damaged file is not a block (the next start checks again). */
export function claimBlockReason(stateDir: string): InstructionCanaryReason | undefined {
  const state = readCanaryState(stateDir);
  return state?.status === "blocked" ? state.reason : undefined;
}

export interface EnsureDeps {
  stateDir: string;
  binaryPath: string;
  binaryVersion: string | undefined;
  argv: string;
  now: () => Date;
  check: () => Promise<InstructionCanaryResult>;
}

/** Runs the check unless the stored pass still describes this build, stores the answer, and returns the block reason (undefined: claiming may go on). */
export async function ensureInstructionCanary(deps: EnsureDeps): Promise<InstructionCanaryReason | undefined> {
  const kept = readCanaryState(deps.stateDir);
  if (kept?.status === "passed" && kept.binary_path === deps.binaryPath && kept.binary_version === deps.binaryVersion && kept.argv === deps.argv && deps.binaryVersion !== undefined) return undefined;
  let result: InstructionCanaryResult;
  try {
    result = await deps.check();
  } catch {
    // fx-swallow-ok: a check that threw proved nothing, which is the inconclusive block
    result = { ok: false, reason: "instruction_canary_inconclusive" };
  }
  const state: CanaryState = {
    status: result.ok ? "passed" : "blocked",
    ...(result.ok ? {} : { reason: result.reason }),
    binary_path: deps.binaryPath,
    binary_version: deps.binaryVersion,
    argv: deps.argv,
    checked_at: deps.now().toISOString(),
  };
  writePrivateFile(deps.stateDir, CANARY_STATE_FILE, `${JSON.stringify(state)}\n`);
  return result.ok ? undefined : result.reason;
}

/**
 * D#601 MEM-7, at the start of every job: the stored pass must describe the build this job would run (CWE-367: the CLI can be updated in place
 * under a running daemon). Returns the block reason when the job must be refused unstarted, undefined when the pass matches.
 * A mismatch (or no pass at all) stores a block first, so claiming is held while the check runs again for the new build, then the check runs once;
 * a pass lifts the block, a failure or an inconclusive result keeps it. The job that met the change is refused either way.
 * A block already stored is not re-run here (that would spend a model turn per job); the next start checks it.
 */
export async function guardJobBuild(deps: EnsureDeps): Promise<InstructionCanaryReason | undefined> {
  const kept = readCanaryState(deps.stateDir);
  if (kept?.status === "blocked" && kept.reason !== undefined) return kept.reason;
  const same = kept?.status === "passed" && kept.binary_path === deps.binaryPath && kept.binary_version === deps.binaryVersion && kept.argv === deps.argv && deps.binaryVersion !== undefined;
  if (same) return undefined;
  // Hold claiming now (synchronously, before any await), so concurrent jobs and claims see the block while the check runs.
  const hold: CanaryState = { status: "blocked", reason: "instruction_canary_inconclusive", binary_path: deps.binaryPath, binary_version: deps.binaryVersion, argv: deps.argv, checked_at: deps.now().toISOString() };
  writePrivateFile(deps.stateDir, CANARY_STATE_FILE, `${JSON.stringify(hold)}\n`);
  return (await ensureInstructionCanary(deps)) ?? "instruction_canary_inconclusive";
}

export const CANARY_BLOCK_HINT: Record<InstructionCanaryReason, string> = {
  instruction_file_loaded: "this Claude Code build loads a repo's instruction file into runs; no job is claimed until the CLI changes (upgrade or reinstall it, then restart fx-runner)",
  instruction_canary_inconclusive: "the instruction-file check could not finish (is the CLI logged in and reachable?); no job is claimed until it passes. Fix that, then restart fx-runner",
};
