/**
 * D#749 V2c-2b: the answer of a playwright deploy verifier job. The `fxverify` server wrote the accepted answer (checked against the V1 envelope shape and against what the page really
 * showed, plus the account it recorded itself as `signed_in_as`) to `answer.json` in the job's directory. THAT file is the job's answer; the model's own final text is ignored for this role
 * and method. No file, or a file that is not a plain private file of ours (opened without following a link, checked on the open handle) or does not hold a valid envelope, means no answer at
 * all, which the verify stage reads as unverified. The file is removed once read, so a re-claimed run id cannot reuse it.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DEPLOY_VERIFIER_ROLE, type BrowserMethod } from "@fulcrumaxe/runner-protocol";
import { segmentUnder } from "../job/plainSegment.js";
import { groundAnswer } from "../verifyBrowser/ground.js";

const MAX_ANSWER_BYTES = 1_048_576;
/** The shape check only: grounding already happened in the server, which is the only process that saw the page. */
const SHAPE_ONLY = { sawFact: () => true, sawNumber: () => true };

/**
 * The answer of run `runId`, or undefined. Never throws; never returns anything but a validated envelope. `uid`: the user this program runs as; a file of any other owner is no answer.
 */
export function readVerifyAnswer(jobsDir: string, runId: string, uid: number | undefined): Record<string, unknown> | undefined {
  let file: string;
  try {
    file = path.join(segmentUnder(jobsDir, runId), "answer.json");
  } catch {
    // fx-swallow-ok: a run id that is not one plain segment has no answer file
    return undefined;
  }
  let fd: number | undefined;
  try {
    // Opened without following a link, and every check is made on the open handle, so the file cannot be swapped between the check and the read.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_ANSWER_BYTES || (info.mode & 0o077) !== 0 || uid === undefined || info.uid !== uid) return undefined;
    const verdict = groundAnswer(readFileSync(fd, "utf8"), SHAPE_ONLY, { signedInAs: true });
    // One line per journey to the journal (result, step count, the last step's own words and page fact, cut and cleaned): a blocked verify can be read without a re-run.
    if (verdict.ok) {
      const js = (JSON.parse(verdict.json) as { journeys?: { id?: string; result?: string; steps?: { did?: string; dom_fact?: string }[] }[] }).journeys ?? [];
      const clean = (t: unknown): string => String(t ?? "").slice(0, 140).replace(/[^\x20-\x7e]/g, "?");
      for (const j of js) {
        const last = j.steps?.[j.steps.length - 1];
        console.log(`fx-runner: verify journey ${runId.slice(0, 8)} ${clean(j.id).slice(0, 40)} ${clean(j.result)} steps=${j.steps?.length ?? 0} last=${clean(last?.did)} | ${clean(last?.dom_fact)}`);
      }
    }
    return verdict.ok ? (JSON.parse(verdict.json) as Record<string, unknown>) : undefined;
  } catch {
    // fx-swallow-ok: no file, or one that cannot be read, is no answer
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      rmSync(file, { force: true });
    } catch {
      // fx-swallow-ok: a file that cannot be removed is overwritten by the next claim (the engine clears it first) and was already read or refused here
    }
  }
}

/** The closed code a playwright deploy verifier run ends with when its turn finished but the server accepted no answer. */
export const VERIFY_ANSWER_MISSING = "verify_answer_missing";

/**
 * The finished run with its answer taken from the file, for the one role and method that has one; every other run is returned unchanged. A playwright deploy verifier run whose file
 * gives no answer loses whatever the model wrote and ends `failed` with `verify_answer_missing` (D#749): a turn that never reached the server's `submit_answer` (no browser tools, or
 * the model stopped early) is named as such, not handed on as a run that succeeded with nothing in it.
 */
export function withAnswerFile<R extends { status: string; agentOutput?: Record<string, unknown>; workspace?: string }>(job: { role: string; browser_method?: BrowserMethod | undefined }, result: R, read: ((runId: string) => Record<string, unknown> | undefined) | undefined, runId: string): R | { status: "failed"; reason: typeof VERIFY_ANSWER_MISSING; workspace?: string } {
  if (result.status !== "done" || job.role !== DEPLOY_VERIFIER_ROLE || job.browser_method !== "playwright_runner") return result;
  const answer = read?.(runId);
  if (answer === undefined) return { status: "failed", reason: VERIFY_ANSWER_MISSING, ...(result.workspace === undefined ? {} : { workspace: result.workspace }) };
  return { ...result, agentOutput: answer };
}
