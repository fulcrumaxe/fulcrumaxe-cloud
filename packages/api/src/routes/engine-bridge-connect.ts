import { z } from "zod";
import { RepoRoot, bridgeRootTail } from "@fulcrumaxe/runner-protocol";
import { writeEngineAudit } from "@fx/db/src/engineAudit.js";
import {
  BRIDGE_PHASES, BRIDGE_PLANS, BRIDGE_RATE_MAX, countRecentBridgeCommands, hasPendingBridgeCommand, latestBridgeCommand, listBridgeRunners, lockBridgeIssue, recentBridgeRetryAfterS, reportedBridges, rootWasOffered,
  bridgePhase, bridgePlan, type BridgeRunner,
} from "@fx/db/src/engineBridgeConnect.js";
import { EngineCommandsBacklog, NOT_CONFIRMED_AFTER_S, insertEngineCommand } from "@fx/db/src/engineCommands.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { markRunnerWork } from "@fx/core/src/pendingWork.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ApiError, RateLimitedError } from "../errors.js";
import type { RouteEntry } from "../registry.js";

/**
 * D#845 ON-BR-2: one-click Connect and Disconnect for the engine bridge, the person's side. The two commands go to a RUNNER the account owns that is paired with the repo, never to
 * the repo's engine session (there may be none yet), so `operate_off` and `engine_not_connected` do not apply. The runner finds the checkout itself; the person only ever carries a
 * folder that runner offered, within ten minutes, in an answer for this repo. "Connected" is what the runners last reported bridging, never a stamp the cloud made.
 */

const idParamsSchema = z.object({ id: z.string() });
const runnerViewSchema = z.object({ id: z.string(), name: z.string(), has_name: z.boolean(), online: z.boolean(), protocol_ok: z.boolean(), last_seen_at: z.string().nullable() });
const commandSchema = z.object({
  id: z.string(),
  kind: z.enum(["bridge_enable", "bridge_disable"]),
  runner_id: z.string(),
  runner_name: z.string().nullable(),
  state: z.enum(["pending", "delivered", "applied", "refused", "expired", "cancelled", "not_confirmed"]),
  result: z.string().nullable(),
  refusal: z.string().nullable(),
  root_tail: z.string().nullable(),
  /** Whole folders the runner offered: shown to an owner or admin only (a member gets an empty list). */
  candidates: z.array(z.string()),
  /** Copies the runner skipped as unsafe: shown as information, never pickable. Owner or admin only. */
  skipped: z.array(z.string()),
  issued_at: z.string(),
  expires_at: z.string(),
  acked_at: z.string().nullable(),
});
const viewSchema = z.object({
  phase: z.enum(BRIDGE_PHASES),
  /** What a Connect press would do now: send to the one runner, ask which, or why it cannot (no runner paired, none online, only older ones online). */
  plan: z.enum(BRIDGE_PLANS),
  runners: z.array(runnerViewSchema),
  connected: z.object({ runner_id: z.string(), runner_name: z.string(), root_tail: z.string().nullable(), root: z.string().nullable(), reported_at: z.string() }).nullable(),
  command: commandSchema.nullable(),
});
// The protocol package is zod 3 and this one zod 4, so the folder rule is the protocol's own `RepoRoot`, called as a check.
const folder = z.string().min(2).max(1024).refine((p) => RepoRoot.safeParse(p).success, { message: "an absolute folder with no .. part and no control or bidirectional character" });
const connectBodySchema = z.object({ runner_id: z.string().uuid().optional(), repo_root: folder.optional() }).strict();
const issueResponseSchema = z.object({ command_id: z.string(), state: z.literal("pending"), expires_at: z.string(), runner_id: z.string() });

export const engineBridgeConnectRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/engine/repos/{id}/bridge",
    operationId: "getEngineBridgeConnect",
    summary: "Where Connect stands for a repo: the runners, what is connected, and the newest answer",
    description:
      "Any member, session only. `connected` is what a runner last reported bridging (renewed on each of its pulls, and read as gone after 24 hours without one), never a stamp. `phase` says what the screen shows; `plan` what a Connect press would do. " +
      "A folder (`connected.root`, `command.candidates`) is shown only to an owner or admin: a member gets the last two parts of the connected folder and no list. 404 for a repo that is not the account's.",
    minRole: "member",
    idempotency: "never",
    extraResponses: { "404": "No such repo in this account." },
    paramsSchema: idParamsSchema,
    responseSchema: viewSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId, role } = ctx.principal;
      const sees = role === "owner" || role === "admin";
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        const runners = await listBridgeRunners(client, accountId, repoId);
        if (runners === null) throw new ApiError(404, "not_found", "no such repo");
        const [reported, command] = await Promise.all([reportedBridges(client, accountId, repoId), latestBridgeCommand(client, accountId, repoId, NOT_CONFIRMED_AFTER_S)]);
        const names = new Map(runners.map((r) => [r.id, r.name]));
        const first = reported.find((b) => names.has(b.runner_id));
        const phase = bridgePhase({ connected: first !== undefined, command, now: new Date() });
        return {
          phase,
          plan: bridgePlan(runners),
          runners: runners.map((r) => ({ id: r.id, name: r.name, has_name: r.has_name, online: r.online, protocol_ok: r.protocol_ok, last_seen_at: r.last_seen_at?.toISOString() ?? null })),
          connected: first === undefined ? null : { runner_id: first.runner_id, runner_name: names.get(first.runner_id)!, root_tail: first.root === null ? null : bridgeRootTail(first.root), root: sees ? first.root : null, reported_at: first.reported_at.toISOString() },
          command:
            command === null
              ? null
              : {
                  id: command.id, kind: command.kind, runner_id: command.runner_id, runner_name: names.get(command.runner_id) ?? null, state: command.state, result: command.result, refusal: command.refusal,
                  root_tail: command.root_tail, candidates: sees ? command.candidates : [], skipped: sees ? command.skipped : [], issued_at: command.issued_at.toISOString(), expires_at: command.expires_at.toISOString(), acked_at: command.acked_at?.toISOString() ?? null,
                },
        };
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/engine/repos/{id}/bridge",
    operationId: "connectEngineBridge",
    summary: "Ask a runner to connect the engine bridge for a repo",
    description:
      "Owner or admin, session only (a token is 403 `session_required`, a member 403). The command goes to one runner the account owns that is paired with the repo and speaks protocol 24 or later: the only one online, or the `runner_id` the person chose " +
      "(an id that is not a paired runner of this account is 404). None online is 409 `no_runner_online`, only older ones 409 `runner_too_old`, several with no choice 409 `runner_choice_needed`. " +
      "`repo_root` is accepted only if that runner offered it for this repo in the last 10 minutes (else 400 `root_not_offered`). At most 5 bridge commands per account per 10 minutes (429 `rate_limited`), and one waiting per repo (409 `bridge_pending`). " +
      "It needs neither operate nor a live engine session. Answers 201 `pending` with the expiry (10 minutes) and writes `engine_command.issued` in the same transaction.",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "optional",
    rateClass: "write",
    successStatus: 201,
    extraResponses: { "400": "`root_not_offered`.", "404": "No such repo or runner in this account.", "409": "`bridge_pending`, `no_runner_online`, `runner_too_old`, `runner_choice_needed` or `too_many_pending`.", "429": "`rate_limited`: 5 bridge commands in 10 minutes." },
    paramsSchema: idParamsSchema,
    bodySchema: connectBodySchema,
    responseSchema: issueResponseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      const body = input.body as { runner_id?: string; repo_root?: string };
      try {
        const issued = await withTenant(ctx.pool, accountId, userId, async (client) => {
          const runners = await listBridgeRunners(client, accountId, repoId);
          if (runners === null) throw new ApiError(404, "not_found", "no such repo");
          await lockBridgeIssue(client, accountId);
          const target = await pickRunner(runners, body.runner_id);
          if (await countRecentBridgeCommands(client, accountId) >= BRIDGE_RATE_MAX) throw new RateLimitedError(await recentBridgeRetryAfterS(client, accountId));
          if (await hasPendingBridgeCommand(client, accountId, repoId)) throw new ApiError(409, "bridge_pending", "a connect or disconnect for this repo is already waiting");
          if (body.repo_root !== undefined && !(await rootWasOffered(client, accountId, repoId, target.id, body.repo_root))) throw new ApiError(400, "root_not_offered", "that folder was not offered by the runner");
          const row = await insertEngineCommand(client, { accountId, runnerId: target.id, repoId, kind: "bridge_enable", args: body.repo_root === undefined ? {} : { repo_root: body.repo_root }, issuedBy: userId, haltEpoch: 0 });
          await writeEngineAudit(client, "engine_command.issued", { repo_id: repoId, command_id: row.id, kind: "bridge_enable" });
          return { ...row, runnerId: target.id };
        });
        void markRunnerWork(accountId);
        return { command_id: issued.id, state: "pending" as const, expires_at: issued.expires_at.toISOString(), runner_id: issued.runnerId };
      } catch (error) {
        throw mapIssueError(error);
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/engine/repos/{id}/bridge",
    operationId: "disconnectEngineBridge",
    summary: "Ask the connected runner to stop bridging a repo",
    description:
      "Owner or admin, session only. The command goes to the runner that last reported bridging the repo, even while it is offline (it waits up to 10 minutes; past that it expires unanswered, and while a runner still reports the repo the phase is `disconnect_failed` (\"did not reach\") until a newer command is answered or the report drops the repo). A disconnect the runner refused reads `disconnect_refused`, with the reason in the command's `refusal`. " +
      "A repo no runner reports bridging is 409 `bridge_not_connected`. The runner removes only its bridge state for the repo, never the engine's state directory or the checkout. Same limits as Connect: 5 per account per 10 minutes, one waiting per repo.",
    minRole: "admin",
    idempotency: "optional",
    rateClass: "write",
    successStatus: 201,
    extraResponses: { "404": "No such repo in this account.", "409": "`bridge_pending`, `bridge_not_connected`, `runner_too_old` or `too_many_pending`.", "429": "`rate_limited`: 5 bridge commands in 10 minutes." },
    paramsSchema: idParamsSchema,
    responseSchema: issueResponseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      try {
        const issued = await withTenant(ctx.pool, accountId, userId, async (client) => {
          const runners = await listBridgeRunners(client, accountId, repoId);
          if (runners === null) throw new ApiError(404, "not_found", "no such repo");
          await lockBridgeIssue(client, accountId);
          const reported = (await reportedBridges(client, accountId, repoId)).find((b) => runners.some((r) => r.id === b.runner_id));
          if (reported === undefined) throw new ApiError(409, "bridge_not_connected", "no runner reports bridging this repo");
          const target = runners.find((r) => r.id === reported.runner_id)!;
          if (!target.protocol_ok) throw new ApiError(409, "runner_too_old", "that runner is too old to take this; update fx-runner on it");
          if (await countRecentBridgeCommands(client, accountId) >= BRIDGE_RATE_MAX) throw new RateLimitedError(await recentBridgeRetryAfterS(client, accountId));
          if (await hasPendingBridgeCommand(client, accountId, repoId)) throw new ApiError(409, "bridge_pending", "a connect or disconnect for this repo is already waiting");
          const row = await insertEngineCommand(client, { accountId, runnerId: target.id, repoId, kind: "bridge_disable", args: {}, issuedBy: userId, haltEpoch: 0 });
          await writeEngineAudit(client, "engine_command.issued", { repo_id: repoId, command_id: row.id, kind: "bridge_disable" });
          return { ...row, runnerId: target.id };
        });
        void markRunnerWork(accountId);
        return { command_id: issued.id, state: "pending" as const, expires_at: issued.expires_at.toISOString(), runner_id: issued.runnerId };
      } catch (error) {
        throw mapIssueError(error);
      }
    },
  },
];

/** The runner a Connect goes to: the one the person chose (it must be one of the account's runners paired with the repo), or the only one that is online and new enough. */
async function pickRunner(runners: readonly BridgeRunner[], chosen: string | undefined): Promise<BridgeRunner> {
  if (chosen !== undefined) {
    const found = runners.find((r) => r.id === chosen.toLowerCase());
    if (found === undefined) throw new ApiError(404, "not_found", "no such runner");
    if (!found.protocol_ok) throw new ApiError(409, "runner_too_old", "that runner is too old to take this; update fx-runner on it");
    if (!found.online) throw new ApiError(409, "no_runner_online", "that runner is not online");
    return found;
  }
  const plan = bridgePlan(runners);
  if (plan === "send") return runners.find((r) => r.online && r.protocol_ok)!;
  if (plan === "choose") throw new ApiError(409, "runner_choice_needed", "more than one runner is online: choose which");
  if (plan === "old") throw new ApiError(409, "runner_too_old", "the runner that is online is too old to take this; update fx-runner on it");
  throw new ApiError(409, "no_runner_online", plan === "no_runner" ? "no runner is paired with this repo" : "no runner is online");
}

function mapIssueError(error: unknown): unknown {
  if (error instanceof EngineCommandsBacklog) return new ApiError(409, "too_many_pending", "too many commands are waiting");
  if ((error as { code?: string } | null)?.code === "42501") return new ApiError(403, "forbidden", "only an owner or admin can connect or disconnect the bridge");
  return error;
}
