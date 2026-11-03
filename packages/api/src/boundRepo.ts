import { itemInRepo } from "@fx/core/src/tokens/delegation.js";
import { UUID_RE, notFound } from "./routes/run-actions.js";
import type { Principal } from "./principal.js";
import type { RouteContext } from "./registry.js";

/** What a bound check can be asked about. A repo id is compared as given; the rest are looked up under the caller's tenant. */
export type BoundRef = { workItemId: string } | { correctionId: string } | { runId: string } | { repoId: string };

/**
 * D#597 CC-4 / CC-4b: an assistant delegation token is bound to one repo. Its calls on anything of another repo answer 404, exactly as an
 * unknown id does, so the answer never says whether the thing exists. A session, and an ordinary token, are not bound.
 */
export async function assertBoundRepo(ctx: Pick<RouteContext, "pool"> & { principal: Principal }, ref: BoundRef): Promise<void> {
  const bound = ctx.principal.delegation;
  if (!bound) return;
  if ("repoId" in ref) {
    if (ref.repoId.toLowerCase() !== bound.repoId.toLowerCase()) throw notFound();
    return;
  }
  const id = Object.values(ref)[0] ?? "";
  if (!UUID_RE.test(id)) throw notFound(); // a malformed id must not reach Postgres (22P02 would be a 500); it answers like an unknown one
  if (!(await itemInRepo(ctx.pool, ctx.principal, ref, bound.repoId))) throw notFound();
}

/**
 * The repo a list read is forced to. A session or ordinary token keeps the filter it asked for. A delegation token reads its own repo only:
 * no filter means its repo, the same repo means itself, any other repo answers 404 (a repo that does not exist answers the same).
 */
export function boundListRepo(principal: Principal, asked: string | undefined): string | undefined {
  const bound = principal.delegation;
  if (!bound) return asked;
  if (asked !== undefined && asked.toLowerCase() !== bound.repoId.toLowerCase()) throw notFound();
  return bound.repoId;
}
