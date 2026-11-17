import { EngineDialsReply, ENGINE_DIALS_PATH, ENGINE_DECISION_TYPES, engineDialsTarget } from "@fulcrumaxe/runner-protocol";
import { DIAL_DEFAULT_MARKER, getCurrentDialSetting } from "@fx/db/src/decisions.js";
import type { PoolClient } from "pg";
import { RunnerHttpError, asRunner, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

export { ENGINE_DIALS_PATH };

type DecisionType = (typeof ENGINE_DECISION_TYPES)[number];
type Disposition = "act" | "announce" | "ask";

/**
 * Decides what the catalogue says for one decision, given the repo's stored dial (`null`: no row, so the catalogue default). Injected so this route holds no
 * catalogue of its own: the production one is the decisions package's `resolveEngineDecision`, wired in `pgEngineDialsPorts` (see `engineDialsResolver`).
 */
export interface DialResolver {
  catalogueVersion: number;
  resolve(decisionType: DecisionType, stored: Disposition | null): Disposition;
}

/** Everything the route reads. Each runs inside the one runner transaction. */
export interface EngineDialsPorts {
  resolver: DialResolver;
  /** The repo's id when this runner covers it (the runner's own repos, same account, a `runner_local` repo); null for every other repo, with no way to tell why. */
  covered(client: PoolClient, input: { runnerId: string; repoGhId: number }): Promise<{ repoId: string } | null>;
  /** The repo's own stored dial for `decisionType`; null when it has none or sits on the catalogue default. */
  storedDial(client: PoolClient, repoId: string, decisionType: DecisionType): Promise<Disposition | null>;
  halt(client: PoolClient, repoId: string): Promise<{ halted: boolean; epoch: number }>;
  now(): Date;
}

/**
 * `?repo_gh_id=N`, exactly, with N a positive whole number in canonical spelling (no sign, no leading zero, nothing else in the query). The signature covers the
 * target the runner built with `engineDialsTarget`, so any other spelling would fail it anyway; this refuses early and says why.
 */
export function parseDialsQuery(search: string): number {
  const match = /^\?repo_gh_id=([1-9][0-9]{0,15})$/.exec(search);
  const id = match === null ? NaN : Number(match[1]);
  if (!Number.isSafeInteger(id)) throw new RunnerHttpError(400, "invalid_message", "the request does not match the protocol");
  return id;
}

/** The database side. The halt read tolerates EB-11a's table being absent (nothing can be halted yet) and its epoch column being absent (epoch 0). */
export const pgEngineDialsPorts = (resolver: DialResolver): EngineDialsPorts => ({
  resolver,
  now: () => new Date(),
  async covered(client, { runnerId, repoGhId }) {
    const { rows } = await client.query<{ repo_id: string }>(
      `SELECT r.id AS repo_id
         FROM runners rn
         JOIN repos r ON r.account_id = rn.account_id AND r.gh_repo_id = $2
        WHERE rn.id = $1 AND rn.revoked_at IS NULL AND r.id = ANY (rn.allowed_repo_ids) AND r.execution_mode = 'runner_local'
        LIMIT 1`,
      [runnerId, repoGhId],
    );
    return rows[0] === undefined ? null : { repoId: rows[0].repo_id };
  },
  async storedDial(client, repoId, decisionType) {
    const dial = await getCurrentDialSetting(client, repoId, decisionType);
    return dial === null || dial.preset === DIAL_DEFAULT_MARKER ? null : (dial.disposition as Disposition);
  },
  async halt(client, repoId) {
    // TODO(EB-3c): once migration 1031 has merged, qualify the table as `public.engine_repo_controls` and drop the existence check below (the shim for a table that
    // may not exist yet); the check must not outlive the table.
    const present = await client.query<{ present: boolean }>("SELECT to_regclass('engine_repo_controls') IS NOT NULL AS present");
    if (present.rows[0]?.present !== true) return { halted: false, epoch: 0 };
    const { rows } = await client.query<{ halted: boolean; epoch: string | null }>(
      "SELECT (c.halted_at IS NOT NULL) AS halted, to_jsonb(c) ->> 'halt_epoch' AS epoch FROM engine_repo_controls c WHERE c.repo_id = $1",
      [repoId],
    );
    const row = rows[0];
    if (row === undefined) return { halted: false, epoch: 0 };
    const epoch = row.epoch === null ? 0 : Number(row.epoch);
    // An epoch the table holds but this route cannot read as a whole number is a halt it cannot describe: report it halted rather than guess.
    if (!Number.isSafeInteger(epoch) || epoch < 0) return { halted: true, epoch: 0 };
    return { halted: row.halted, epoch };
  },
});

/**
 * GET /api/runner/engine/dials?repo_gh_id=N (EB-9b): the three dispositions the repo's decisions resolve to now, the halt epoch and whether the repo is halted.
 *
 *  - Signed like every runner request, with the query inside the signed target and the nonce usable once. A body, any other method or any other query is
 *    refused before anything is read.
 *  - The repo must be one this runner covers. Every other repo (another account's, an uncovered one, one that does not exist, a repo not on a `runner_local`
 *    machine) answers the same 404, so the route is no way to learn which repos exist.
 *  - `engine_spec_ready` is reported as the repo's own dial for it, which is what a Small, Bug, Doc or Process Spec follows; a Feature or Critical Spec asks
 *    at every preset whatever this says, and the ceiling file does not carry it.
 *  - Nothing is written: no receipt, no audit row.
 */
export async function engineDials(deps: RunnerCloudDeps, req: RunnerHttpRequest, search: string, ports: EngineDialsPorts): Promise<RunnerHttpResponse> {
  if (req.method !== "GET") throw new RunnerHttpError(405, "method_not_allowed", "use GET");
  if (req.body.byteLength > 0) throw new RunnerHttpError(400, "invalid_message", "this request takes no body");
  const repoGhId = parseDialsQuery(search);
  const runner = await verifyRunnerRequest(deps, engineDialsTarget(repoGhId), req, { replay: "once" });
  const reply = await asRunner(() =>
    withRunnerSession(deps.appUserPool, runner, async (client): Promise<EngineDialsReply> => {
      const repo = await ports.covered(client, { runnerId: runner.runnerId, repoGhId });
      if (repo === null) throw new RunnerHttpError(404, "not_found", "no such repo");
      const dispositions = {} as Record<DecisionType, Disposition>;
      for (const type of ENGINE_DECISION_TYPES) dispositions[type] = ports.resolver.resolve(type, await ports.storedDial(client, repo.repoId, type));
      const halt = await ports.halt(client, repo.repoId);
      return EngineDialsReply.parse({
        repo_gh_id: repoGhId,
        catalogue_version: ports.resolver.catalogueVersion,
        dispositions,
        halt_epoch: halt.epoch,
        halted: halt.halted,
        fetched_at: ports.now().toISOString(),
      });
    }),
  );
  return { status: 200, body: reply, headers: { "cache-control": "no-store" } };
}
