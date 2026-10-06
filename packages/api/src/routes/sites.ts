import { z } from "zod";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { ForbiddenError, NotFoundError } from "@fx/core/src/tenancy/errors.js";
// Relative, not a workspace dep: no lockfile change in this PR (D#3 C10 follow-up converts it).
import { approve, attest, buildVerifyReport, carryForward, type Refusal } from "../../../sitekit-publish-gates/src/approval/index.js";
import { ApiError, SitekitRefusedError } from "../errors.js";
import type { RouteEntry } from "../registry.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";

const ATTESTABLE = ["legal", "pricing", "security"];
const reportSchema = z.object({
  version: z.literal(1),
  versionId: z.string(),
  counts: z.record(z.string(), z.number()),
  blockers: z.array(z.object({ source: z.string(), reason: z.string(), claimId: z.string().optional(), detail: z.string() })),
  evidence: z.array(z.object({ claimId: z.string(), path: z.string(), sha: z.string(), date: z.string().optional(), text: z.string(), href: z.string().optional() })),
  ok: z.boolean(),
});
const reviewResponseSchema = z.object({
  version_id: z.string().uuid(),
  /** The site this version belongs to: the billing panel reads its plan from it. */
  site_id: z.string().uuid(),
  approved: z.boolean(),
  /** Advisory: derived from a tenant-writable column. It may disable the button; approve() decides. */
  report: reportSchema,
  pending_links: z.array(z.string()),
  claims: z.array(z.object({ claim_id: z.string().uuid(), claim_key: z.string(), locale: z.string(), kind: z.string(), text: z.string().nullable(), attested: z.boolean() })),
});
const idParams = z.object({ id: z.string().uuid() });

const listItemSchema = z.object({
  version_id: z.string().uuid(),
  created_at: z.string(),
  /** Derived from the approval columns on every read, never stamped. */
  review_state: z.enum(["pending", "approved", "published"]),
  /** Advisory counts: they come from tenant-writable columns and only label the picker. */
  pending_links: z.number().int(),
  pending_claims: z.number().int(),
});
const listResponseSchema = z.object({ data: z.array(listItemSchema), next_cursor: z.string().nullable() });
// limit/cursor stay raw strings: parseLimit and decodeCursor own their 422s, as in the runs list.
const listQuerySchema = z.object({ limit: z.string().optional(), cursor: z.string().optional() });
interface ListRow {
  version_id: string;
  created_at: Date;
  created_at_cursor: string;
  review_state: "pending" | "approved" | "published";
  pending_links: number;
  pending_claims: number;
}

/** The path id, already validated by idParams; a missing one is a fixed 422 rather than a non-null assertion. */
function pathId(input: { params: Record<string, string | undefined> }): string {
  const id = input.params.id;
  if (id === undefined) throw new ApiError(422, "validation_failed", "site version id is required", [{ path: "id", code: "required" }]);
  return id;
}
const attestBodySchema = z
  .object({ claim_id: z.string().uuid().optional(), carry_forward: z.literal(true).optional() })
  .strict()
  .refine((b) => (b.claim_id !== undefined) !== (b.carry_forward !== undefined), { message: "send exactly one of claim_id or carry_forward" });
const attestResponseSchema = z.object({ created: z.boolean(), carried: z.array(z.string().uuid()) });
/**
 * Migration 0678 refuses an audit payload over 65536 bytes, which rolls the approval back into a generic 500.
 * Cap the links' total UTF-8 size well under that (the rest of the payload and jsonb overhead need room), so an
 * oversized request is a 422 before any database work.
 */
const MAX_APPROVED_LINKS_BYTES = 48 * 1024;
const approveBodySchema = z
  .object({ terms_accepted: z.boolean(), approved_links: z.array(z.string().max(2048)).max(200).optional() })
  .strict()
  .refine((b) => (b.approved_links ?? []).reduce((n, l) => n + Buffer.byteLength(l, "utf8"), 0) <= MAX_APPROVED_LINKS_BYTES, {
    message: `approved_links exceed ${MAX_APPROVED_LINKS_BYTES} bytes in total`,
    path: ["approved_links"],
  });
const approveResponseSchema = z.object({ approved_at: z.string(), approved_links: z.array(z.string()) });

/** forbidden -> 403, not_found -> 404, every other typed refusal -> 409 with a fixed code and message. */
function refusalError(r: Refusal, versionId: string): Error {
  if (r.code === "forbidden") return new ForbiddenError("insufficient account role");
  if (r.code === "not_found") return new NotFoundError("site version not found");
  // CWE-209: the raw render error is logged here and never leaves the server.
  if (r.code === "render_failed") console.error(`sitekit approve: render failed for ${versionId}: ${r.detail}`);
  // Findings are attacker-controlled text and stay server-side. The only distinction the caller gets is a fixed
  // code for "nothing failed except that no browser was available".
  if (r.code === "check_failed" && r.checks.every((c) => c.findings.length > 0 && c.findings.every((f) => f.kind === "browser_driver_missing"))) {
    return new SitekitRefusedError("browser_driver_missing");
  }
  return new SitekitRefusedError(r.code);
}

async function audit(client: PoolClient, action: string, payload: Record<string, unknown>): Promise<void> {
  await client.query("SELECT audit_write_sitekit($1::text, $2::jsonb)", [action, JSON.stringify(payload)]);
}

/**
 * D#3 K07b (C8 section 4, C10 section 4): the site-kit review read and the
 * attest / approve writes. The writes are session-only (no `principals`, no
 * scope; D#31 C35 section 1): approving publishes outside our system, so no
 * token can do it. No Idempotency-Key: a repeat approve is a 409.
 */
export const siteRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/sites/{id}/versions",
    operationId: "listSiteVersions",
    summary: "One site's versions, newest first, with each one's review state and what is still pending",
    description:
      "Session only. `limit` is 1 to 200 (default 50); `cursor` is the `next_cursor` of the previous page. A site that is not one of this account's is a 404. The sites themselves come from `GET /api/v1/sites`.",
    // Same rules as the review read: a session, member or above. No token and nothing anonymous.
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParams,
    querySchema: listQuerySchema,
    responseSchema: listResponseSchema,
    extraResponses: { "404": "`not_found`: the site is not one of this account's." },
    async handler(ctx, input) {
      const { accountId, userId } = ctx.principal;
      const id = pathId(input);
      const query = (input.query ?? {}) as z.infer<typeof listQuerySchema>;
      const limit = parseLimit(query.limit);
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        const site = await client.query("SELECT 1 FROM sites WHERE id = $1 AND account_id = $2", [id, accountId]);
        if (site.rowCount === 0) throw new NotFoundError("site not found");
        const { rows } = await client.query<ListRow>(
          `SELECT v.id AS version_id, v.created_at,
                  to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
                  CASE WHEN v.published_at IS NOT NULL THEN 'published'
                       WHEN v.approved_by IS NOT NULL OR v.approved_at IS NOT NULL THEN 'approved'
                       ELSE 'pending' END AS review_state,
                  CASE WHEN jsonb_typeof(v.report->'publishGates'->'pendingLinks') = 'array'
                       THEN jsonb_array_length(v.report->'publishGates'->'pendingLinks') ELSE 0 END AS pending_links,
                  (SELECT count(*)::int FROM claims c
                    WHERE c.site_id = v.site_id AND c.account_id = v.account_id AND c.kind = ANY($3)
                      AND NOT EXISTS (SELECT 1 FROM attestations a WHERE a.claim_id = c.id AND a.version_id = v.id AND a.account_id = c.account_id)) AS pending_claims
             FROM site_versions v
            WHERE v.site_id = $1 AND v.account_id = $2
              AND ($4::timestamptz IS NULL OR (v.created_at, v.id) < ($4::timestamptz, $5::uuid))
            ORDER BY v.created_at DESC, v.id DESC
            LIMIT $6::int`,
          [id, accountId, ATTESTABLE, cursor?.created_at ?? null, cursor?.id ?? null, limit + 1],
        );
        const page = rows.length > limit ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];
        return {
          data: page.map((r) => ({
            version_id: r.version_id,
            created_at: r.created_at.toISOString(),
            review_state: r.review_state,
            pending_links: r.pending_links,
            pending_claims: r.pending_claims,
          })),
          next_cursor: rows.length > limit && last ? encodeCursor(last.created_at_cursor, last.version_id) : null,
        };
      });
    },
  },
  {
    method: "GET",
    path: "/api/v1/site-versions/{id}/review",
    operationId: "getSiteVersionReview",
    summary: "The review data for one site version: claim counts, blockers, evidence and the links awaiting approval",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParams,
    responseSchema: reviewResponseSchema,
    async handler(ctx, input) {
      const { accountId, userId } = ctx.principal;
      const id = pathId(input);
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        const report = await buildVerifyReport(client, accountId, id);
        if (!report) throw new NotFoundError("site version not found");
        const v = await client.query<{ site_id: string; approved: boolean; pending: unknown }>(
          "SELECT site_id, approved_by IS NOT NULL OR approved_at IS NOT NULL AS approved, report->'publishGates'->'pendingLinks' AS pending FROM site_versions WHERE id = $1 AND account_id = $2",
          [id, accountId],
        );
        const c = await client.query(
          `SELECT c.id AS claim_id, c.claim_key, c.locale, c.kind,
                  (SELECT e->>'text' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.content->'claims') = 'array' THEN v.content->'claims' ELSE '[]'::jsonb END) e
                    WHERE e->>'id' = c.claim_key AND e->>'locale' = c.locale LIMIT 1) AS text,
                  EXISTS (SELECT 1 FROM attestations a WHERE a.claim_id = c.id AND a.version_id = v.id AND a.account_id = c.account_id) AS attested
             FROM site_versions v JOIN claims c ON c.site_id = v.site_id AND c.account_id = v.account_id
            WHERE v.id = $1 AND v.account_id = $2 AND c.kind = ANY($3) ORDER BY c.claim_key, c.locale`,
          [id, accountId, ATTESTABLE],
        );
        const stored = Array.isArray(v.rows[0]?.pending) ? (v.rows[0]!.pending as unknown[]) : [];
        const links = new Set<string>([...stored, ...report.evidence.map((e) => e.href)].filter((l): l is string => typeof l === "string"));
        return { version_id: id, site_id: v.rows[0]!.site_id, approved: v.rows[0]?.approved === true, report, pending_links: [...links].sort(), claims: c.rows };
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/site-versions/{id}/attest",
    operationId: "attestSiteClaim",
    summary: "Attest one legal, pricing or security claim on a version, or carry earlier attestations forward",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParams,
    bodySchema: attestBodySchema,
    responseSchema: attestResponseSchema,
    extraResponses: { "409": "A typed refusal: the claim belongs to another site, or is not a legal, pricing or security claim" },
    async handler(ctx, input) {
      const { accountId, userId } = ctx.principal;
      const id = pathId(input);
      const body = input.body as z.infer<typeof attestBodySchema>;
      const p = { accountId, userId };
      const out = await withTenant(ctx.pool, accountId, userId, async (client) => {
        if (body.claim_id) {
          const r = await attest(client, p, body.claim_id, id);
          if (r.ok && r.created) await audit(client, "site.claim_attested", { version_id: id, claim_id: body.claim_id, carried: false });
          return r.ok ? { ok: true as const, created: r.created, carried: [] as string[] } : r;
        }
        const r = await carryForward(client, p, id);
        if (r.ok && r.carried.length > 0) await audit(client, "site.claim_attested", { version_id: id, claim_ids: r.carried, carried: true });
        return r.ok ? { ok: true as const, created: false, carried: r.carried } : r;
      });
      if (!out.ok) throw refusalError(out.refusal, id);
      return { created: out.created, carried: out.carried };
    },
  },
  {
    method: "POST",
    path: "/api/v1/site-versions/{id}/approve",
    operationId: "approveSiteVersion",
    summary: "Approve a site version: re-renders on the server and re-runs the publish gates; does not publish",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParams,
    bodySchema: approveBodySchema,
    responseSchema: approveResponseSchema,
    extraResponses: { "409": "A typed refusal: the version is already approved, terms not accepted, or a gate or site check refused it (check_failed; browser_driver_missing while no browser is available on the server)" },
    async handler(ctx, input) {
      const { accountId, userId } = ctx.principal;
      const id = pathId(input);
      const body = input.body as z.infer<typeof approveBodySchema>;
      // Exactly the links the caller listed, as displayed. Never filled from the pending list; assetRoot is never taken from input.
      const approvedLinks = body.approved_links ?? [];
      const out = await withTenant(ctx.pool, accountId, userId, async (client) => {
        // approve() persists its gate result before refusing, so a refusal commits too.
        const r = await approve(client, { accountId, userId }, id, { termsAccepted: body.terms_accepted, approvedLinks });
        if (r.ok) await audit(client, "site.version_approved", { version_id: id, approved_links: approvedLinks, terms_accepted: true });
        return r;
      });
      if (!out.ok) throw refusalError(out.refusal, id);
      return { approved_at: out.approvedAt.toISOString(), approved_links: approvedLinks };
    },
  },
];
