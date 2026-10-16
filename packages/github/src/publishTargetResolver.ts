import type { Pool } from "pg";
import { reportError } from "@fx/telemetry";

/**
 * D#598 P1f-4a: which paired public repository and branch a sandbox's publish run may name, answered from our own rows.
 *
 * The question goes to the database function `resolve_plane_publish_target` (migration 0834) on the narrow gh-proxy login, the same pool and login as
 * `createRunResolver`. Its one input is the sandbox name from the verified OIDC claim, passed as an opaque value. The function answers one row, or none.
 * Every other outcome here is null as well: no row, two rows, a row whose values do not have the shape our own writer guarantees, a null name, or any
 * database error. The proxy turns null into a denial without saying which of these fired.
 */
export interface PublishTarget {
  /** The paired public repository's full name, as stamped at build start (`owner/name`). */
  codeRepo: string;
  /** The public branch the platform pushes for this item (`fx/p-<plane_pushes.id>`). */
  branch: string;
}

export type PublishTargetResolver = (sandboxName: string) => Promise<PublishTarget | null>;

interface TargetRow {
  code_repo: unknown;
  branch: unknown;
}

const RESOLVE_QUERY = "SELECT code_repo, branch FROM public.resolve_plane_publish_target($1)";

const STAGE = "github.plane_publish_target_resolve";

// The same shapes 0831 enforces on the columns. A value that does not match is refused here too, so a row the database should never hold cannot become a repository.
const CODE_REPO = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^fx\/p-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Builds the resolver on the narrow gh-proxy pool (`DATABASE_URL_GH_PROXY`). */
export function createPublishTargetResolver(ghProxyPool: Pool): PublishTargetResolver {
  return async function resolvePublishTarget(sandboxName: string): Promise<PublishTarget | null> {
    if (typeof sandboxName !== "string" || sandboxName.length === 0) return null;

    let rows: TargetRow[];
    try {
      rows = (await ghProxyPool.query<TargetRow>(RESOLVE_QUERY, [sandboxName])).rows;
    } catch (err) {
      // Reported by class only (the error's text is never read); the sandbox gets the generic denial.
      reportError(err, { stage: STAGE });
      return null;
    }

    if (rows.length !== 1) return null;
    const row = rows[0]!;
    if (typeof row.code_repo !== "string" || typeof row.branch !== "string") return null;
    if (!CODE_REPO.test(row.code_repo)) return null;
    const name = row.code_repo.split("/")[1];
    if (name === "." || name === "..") return null;
    if (!BRANCH.test(row.branch)) return null;
    return { codeRepo: row.code_repo, branch: row.branch };
  };
}
