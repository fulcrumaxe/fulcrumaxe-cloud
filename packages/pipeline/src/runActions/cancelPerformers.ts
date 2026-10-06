import type { Performer } from "./dispatcher.js";

/**
 * D#2 H14c-3b: the two cancel performers. Each passes the action id and nothing
 * else (no principal, user, token, requested_by or kind): the facade asks the
 * database who the action runs as, for session and token requests alike, and
 * calls the runner's `cancelRun` unchanged inside.
 */
export const performCancelRun: Performer = (worker, actionId) => worker.performCancelRun(actionId);
export const performCancelWorkItem: Performer = (worker, actionId) => worker.performCancelWorkItem(actionId);
