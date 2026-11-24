import type { NextRequest } from "next/server";
import { applyRunnerSetting, cancelClaudeLogin, checkRunner, enqueueSandboxCommand, readClaudeLogin, removeRunner, setRunnerRepos, signOutOfClaude, startClaudeLogin, submitClaudeLoginCode, type FleetSettingAction } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../lib/runnerRoutes";

/**
 * D#605 FL-8: the fleet control routes share these three handlers. Each is a session route (a runner signature is no credential and gets 401) and each
 * decision carries the signed-in person's id; the database decides who may do what.
 */

/** POST /api/runners/:id/{pause,drain,resume,rename,labels,rank}. */
export const fleetSettingHandler = (req: NextRequest, runnerId: string, action: FleetSettingAction) =>
  handleSessionRequest(req, (deps, principal, body) => applyRunnerSetting(deps, principal, runnerId, action, body), { json: true });

/** POST /api/runners/:id/repos with { repo_ids }. */
export const fleetReposHandler = (req: NextRequest, runnerId: string) =>
  handleSessionRequest(req, (deps, principal, body) => setRunnerRepos(deps, principal, runnerId, body), { json: true });

/** POST /api/runners/:id/check (D#6 RUNNER-PING): "Check runner now", owners and admins only. */
export const fleetCheckHandler = (req: NextRequest, runnerId: string) =>
  handleSessionRequest(req, (deps, principal, body) => checkRunner(deps, principal, runnerId, body), { json: true });

/** POST /api/runners/:id/remove. */
export const fleetRemoveHandler = (req: NextRequest, runnerId: string) => handleSessionRequest(req, (deps, principal) => removeRunner(deps, principal, runnerId));

/** POST /api/runners/:id/sandbox-commands (D#587 B-7b-ii) with { kind, name? }: stop or delete a named sandbox, or reap the stopped ones. Owners and admins only; the database decides. */
export const fleetSandboxCommandHandler = (req: NextRequest, runnerId: string) => handleSessionRequest(req, (deps, principal, body) => enqueueSandboxCommand(deps, principal, runnerId, body), { json: true });

/**
 * D#845 MC-8a: the Claude sign-in link for a managed server. All five are session routes for an owner or admin (a runner signature gets 401; the database decides the rest).
 * POST claude-login starts one, GET claude-login reads it (with its link while it waits), POST claude-login/code takes the person's code, POST claude-login/cancel ends it, POST claude-logout signs the machine out.
 */
export const claudeLoginStartHandler = (req: NextRequest, runnerId: string) => handleSessionRequest(req, (deps, principal) => startClaudeLogin(deps, principal, runnerId));
export const claudeLoginReadHandler = (req: NextRequest, runnerId: string) => handleSessionRequest(req, (deps, principal) => readClaudeLogin(deps, principal, runnerId));
export const claudeLoginCodeHandler = (req: NextRequest, runnerId: string) => handleSessionRequest(req, (deps, principal, body) => submitClaudeLoginCode(deps, principal, runnerId, body), { json: true });
export const claudeLoginCancelHandler = (req: NextRequest, runnerId: string) => handleSessionRequest(req, (deps, principal) => cancelClaudeLogin(deps, principal, runnerId));
export const claudeLogoutHandler = (req: NextRequest, runnerId: string) => handleSessionRequest(req, (deps, principal) => signOutOfClaude(deps, principal, runnerId));
