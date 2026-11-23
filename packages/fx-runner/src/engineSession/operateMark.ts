/**
 * D#845 ON-13a1: the operate high-water mark. Operate is one switch per account, and the cloud counts its changes (`operate_epoch`). Every signed session job carries the epoch the cloud read when it issued
 * it. The runner keeps `{runner_id, operate_epoch}` in `<stateDir>/engine-session/operate-mark.json` (0600, under a 0700 directory, written without following a link, atomically) and raises it to the
 * largest epoch of any VERIFIED job before anything else happens. A start whose epoch is below the mark the runner held before the job is stale, so a replayed or delayed start can never come up in
 * a later operate-off period; a stop or a delete is never refused for being stale (stopping is the safe direction).
 *
 * The mark is learned only from verified signed bytes, never from a reply the transport could lower. A missing mark, one written for another `runner_id` (a re-registered machine) and one that is not
 * well formed all read as 0; the last is logged as one closed event, `operate_mark_reset`. A mark that is a link or not a plain file is NOT read or written through: that is `unsafe`, and the caller refuses.
 * Only the holder of the runner's key can write this directory, and the key it holds is the runner's, not the job signer's, so a rewritten mark gains it nothing it did not have.
 */
import { lstatSync } from "node:fs";
import path from "node:path";
import { readJsonNoFollow, writeJsonAtomic } from "../engineBridge/stateFiles.js";

export const OPERATE_MARK_DIR = "engine-session";
export const OPERATE_MARK_FILE = "operate-mark.json";

export type MarkResult = { ok: true; prior: number } | { ok: false };
export interface OperateMark {
  /** Raises the mark to `max(mark, epoch)` and answers the mark it held before. `ok: false` when the file is not safe to use (a link or not a plain file) or could not be written; nothing was written through it. */
  observe(runnerId: string, epoch: number): MarkResult;
}
export type OperateMarkEvent = { event: "operate_mark_reset" };

const isEpoch = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function createOperateMark(deps: { stateDir: string; uid: number; log?: (event: OperateMarkEvent) => void }): OperateMark {
  const dir = path.join(deps.stateDir, OPERATE_MARK_DIR);
  const file = path.join(dir, OPERATE_MARK_FILE);
  return {
    observe(runnerId, epoch) {
      if (!isEpoch(epoch)) return { ok: false };
      let held = 0;
      let stored = false;
      try {
        const st = lstatSync(file, { throwIfNoEntry: false });
        if (st !== undefined && (st.isSymbolicLink() || !st.isFile())) return { ok: false };
        if (st !== undefined) {
          let value: unknown;
          try {
            value = readJsonNoFollow(dir, OPERATE_MARK_FILE, deps.uid);
          } catch {
            // fx-swallow-ok: a file that cannot be read or parsed is a malformed mark: it reads as missing and is logged as one closed event
            value = undefined;
          }
          const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
          if (record === undefined || Object.keys(record).sort().join(",") !== "operate_epoch,runner_id" || typeof record["runner_id"] !== "string" || !isEpoch(record["operate_epoch"])) deps.log?.({ event: "operate_mark_reset" });
          else if (record["runner_id"].toLowerCase() === runnerId.toLowerCase()) {
            held = record["operate_epoch"];
            stored = true;
          }
        }
        const next = Math.max(held, epoch);
        if (!stored || next !== held) writeJsonAtomic(dir, OPERATE_MARK_FILE, { runner_id: runnerId.toLowerCase(), operate_epoch: next }, deps.uid);
        return { ok: true, prior: held };
      } catch {
        // fx-swallow-ok: a directory that is not ours, a write that failed: the mark is unusable and the caller refuses a start; the error text is not kept
        return { ok: false };
      }
    },
  };
}
