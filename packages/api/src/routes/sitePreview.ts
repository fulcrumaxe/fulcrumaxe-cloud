import { z } from "zod";
import { withTenant } from "@fx/db/src/withTenant.js";
import { isSetupPaid } from "@fx/billing";
import {
  SITEKIT_PREVIEW_COMPUTE_CAP_USD,
  SITEKIT_PREVIEW_MODEL_CAP_USD,
  previewLocks,
  summaryLine,
} from "@fx/sitekit-pipeline";
import { ApiError } from "../errors.js";
import { RawBody, type RouteContext, type RouteEntry } from "../registry.js";

/**
 * D#3 K10 seam, installed by apps/web's catch-all like `onboardingDeps`. `available` stays false until the run starter for a
 * requested site preview is wired, so the POST answers 503 `preview_unavailable` and writes nothing until then.
 * `announce` tells the runner a preview was requested; it is best effort (the row is already stored).
 */
export const sitePreviewDeps: {
  available: () => boolean;
  announce: ((p: { accountId: string; previewId: string }) => Promise<void>) | null;
} = {
  available: () => false,
  announce: null,
};

const idParams = z.object({ id: z.string().uuid() });
const requestBodySchema = z.strictObject({ confirm_model_cap_usd: z.number() });

const lockSchema = z.object({ locked: z.boolean(), label: z.string().nullable() });
const PREVIEW_STATES = ["requested", "running", "finished", "failed", "void"] as const;
const previewSchema = z.object({
  preview_id: z.string().uuid(),
  state: z.enum(PREVIEW_STATES),
  /** A closed lower-case code for a failed or void preview, or null. */
  reason: z.string().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
  summary: z.object({ claims: z.number().int(), unverifiable: z.number().int(), blockers: z.number().int(), line: z.string() }).nullable(),
  /** The same-origin path that serves the render, or null until the preview has finished. */
  homepage_url: z.string().nullable(),
});
export const sitePreviewResponseSchema = z.object({
  preview: previewSchema.nullable(),
  model_cap_usd: z.number(),
  compute_cap_usd: z.number(),
  locks: z.object({ full_site: lockSchema, downloads: lockSchema, publish: lockSchema }),
});
const acceptedSchema = z.object({ preview_id: z.string().uuid(), state: z.string() });

/** Every message is fixed text: nothing from the database, the repository or the caller is forwarded. */
function previewError(err: unknown): never {
  const code = (err as { code?: string } | null)?.code;
  if (code === "PX422") throw new ApiError(422, "preview_cap_not_confirmed", `the model spending cap must be confirmed exactly`);
  // A parallel second request passes the stamp check and loses on the stamp table's unique indexes: it is the same refusal.
  if (code === "PX409" || code === "23505") throw new ApiError(409, "preview_used", "Preview already used");
  if (code === "PX429") throw new ApiError(409, "preview_capacity", "today's preview allowance is used up");
  if (code === "P0002") throw new ApiError(404, "not_found", "not found");
  if (code === "42501") throw new ApiError(403, "insufficient_role", "requires a session owner or admin");
  throw err;
}

function siteId(input: { params: Record<string, string | undefined> }): string {
  const id = input.params.id;
  if (id === undefined) throw new ApiError(422, "validation_failed", "site id is required", [{ path: "id", code: "required" }]);
  return id;
}

interface PreviewRow {
  id: string;
  state: (typeof PREVIEW_STATES)[number];
  reason: string | null;
  created_at: Date;
  finished_at: Date | null;
  claims_total: number | null;
  claims_unverifiable: number | null;
  blockers: number | null;
  has_homepage: boolean;
}

/** sandbox with no allow-* token, nothing it may run, and nothing it may load but inline data: images; only a page of our own origin may frame it. */
export const RENDER_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
  "X-Content-Type-Options": "nosniff",
};

async function readSitePreview(ctx: RouteContext, id: string): Promise<z.infer<typeof sitePreviewResponseSchema>> {
  const { accountId, userId } = ctx.principal;
  const read = await withTenant(ctx.pool, accountId, userId, undefined, async (client) => {
    const site = await client.query("SELECT 1 FROM sites WHERE id = $1", [id]);
    if (site.rowCount === 0) return null;
    const { rows } = await client.query<PreviewRow>(
      `SELECT id, state, reason, created_at, finished_at, claims_total, claims_unverifiable, blockers, homepage_html IS NOT NULL AS has_homepage
         FROM sitekit_previews WHERE site_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [id],
    );
    return { row: rows[0] ?? null, paid: await isSetupPaid(client, accountId, id) };
  });
  if (read === null) throw new ApiError(404, "not_found", "not found");
  const r = read.row;
  const summary =
    r !== null && r.state === "finished" && r.claims_total !== null && r.claims_unverifiable !== null && r.blockers !== null
      ? { claims: r.claims_total, unverifiable: r.claims_unverifiable, blockers: r.blockers, line: summaryLine(r.claims_total, r.claims_unverifiable, r.blockers) }
      : null;
  return {
    preview:
      r === null
        ? null
        : {
            preview_id: r.id,
            state: r.state,
            reason: r.reason,
            created_at: r.created_at.toISOString(),
            finished_at: r.finished_at?.toISOString() ?? null,
            summary,
            homepage_url: r.state === "finished" && r.has_homepage ? `/api/v1/sites/${id}/preview/render` : null,
          },
    model_cap_usd: SITEKIT_PREVIEW_MODEL_CAP_USD,
    compute_cap_usd: SITEKIT_PREVIEW_COMPUTE_CAP_USD,
    locks: previewLocks(read.paid),
  };
}

/**
 * D#3 K10: a site's one read-only preview. The request is the database's (`sitekit_preview_request`): it checks the role, the
 * exact cap, the one-time stamp and the day's counter, and writes nothing on a refusal. The read answers the newest preview and
 * what is still locked, from stored state only, so a reload shows what the last screen showed.
 */
export const sitePreviewRoutes: RouteEntry[] = [
  {
    method: "POST",
    path: "/api/v1/sites/{id}/preview",
    operationId: "requestSitePreview",
    summary: "Ask for the site's one read-only preview",
    description:
      "Session only, owner or admin; a token is refused. The body must repeat the model spending cap exactly (the `model_cap_usd` that `GET /api/v1/sites/{id}/preview` answers) so the customer has seen it. " +
      "A site gets one preview per GitHub user and per installation, and uninstalling and reinstalling the App does not give another. " +
      "Answers 202 `{ preview_id, state }`; read the result with `GET /api/v1/sites/{id}/preview`.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParams,
    bodySchema: requestBodySchema,
    responseSchema: acceptedSchema,
    successStatus: 202,
    extraResponses: {
      "403": "Error `session_required` (a token) or `insufficient_role` (below admin).",
      "404": "Error `not_found`: the site is missing, belongs to another account, or is not on the site-kit App.",
      "409": "Error `preview_used` (this GitHub user or installation already had its preview) or `preview_capacity` (today's allowance is used up).",
      "422": "Error `preview_cap_not_confirmed` (the cap must equal `model_cap_usd`), or a body that does not validate.",
      "503": "Error `preview_unavailable`: previews cannot run yet. Nothing is written.",
    },
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof requestBodySchema>;
      if (!sitePreviewDeps.available()) throw new ApiError(503, "preview_unavailable", "previews cannot run yet");
      const { accountId, userId } = ctx.principal;
      const row = await withTenant(ctx.pool, accountId, userId, undefined, async (client) => {
        const { rows } = await client.query<{ preview_id: string; state: string }>("SELECT preview_id, state FROM sitekit_preview_request($1, $2)", [siteId(input), body.confirm_model_cap_usd]);
        return rows[0]!;
      }).catch(previewError);
      try {
        await sitePreviewDeps.announce?.({ accountId, previewId: row.preview_id });
      } catch {
        // fx-swallow-ok: the row is stored and the runner finds it on its next sweep; a failed nudge never undoes the request
      }
      return { preview_id: row.preview_id, state: row.state };
    },
  },
  {
    method: "GET",
    path: "/api/v1/sites/{id}/preview/render",
    operationId: "getSitePreviewRender",
    summary: "The homepage render of the site's finished preview, as a page for a sandboxed frame",
    description:
      "Session only. The page is built from repository text, so the response carries a policy that gives it no script, no form, no same-origin access and no network, and `nosniff`. " +
      "Answers the stored HTML of the site's newest preview only while that preview has finished; every other case, another account's site included, is `not_found`.",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParams,
    responseSchema: z.string(),
    rawResponse: { contentType: "text/html; charset=utf-8", description: "The stored homepage render.", headers: RENDER_HEADERS },
    extraResponses: { "404": "Error `not_found`: the site is not one of this account's, or has no finished preview." },
    async handler(ctx, input) {
      const { accountId, userId } = ctx.principal;
      const id = siteId(input);
      const html = await withTenant(ctx.pool, accountId, userId, undefined, async (client) => {
        const { rows } = await client.query<{ state: string; homepage_html: string | null }>(
          "SELECT state, homepage_html FROM sitekit_previews WHERE site_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
          [id],
        );
        const r = rows[0];
        return r !== undefined && r.state === "finished" ? r.homepage_html : null;
      });
      if (html === null || html === "") throw new ApiError(404, "not_found", "not found");
      const chunks = (async function* () {
        yield html;
      })();
      return new RawBody("text/html; charset=utf-8", RENDER_HEADERS, chunks);
    },
  },
  {
    method: "GET",
    path: "/api/v1/sites/{id}/preview",
    operationId: "getSitePreview",
    summary: "The site's newest preview and what stays locked until setup is paid",
    description:
      "Session only. `preview` is null when none was requested. `summary.line` reads \"N claims, M unverifiable, K blockers\" once the preview has finished. " +
      "`homepage_url` is the path of the page built from repository text, set once the preview has finished: show it only in a sandboxed `iframe src`, never inline. " +
      "`locks` names what stays locked (`full_site`, `downloads`, `publish`) with the label \"Setup payment required\" until the site's setup is paid.",
    principals: ["session"],
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParams,
    responseSchema: sitePreviewResponseSchema,
    extraResponses: { "404": "Error `not_found`: the site is not one of this account's." },
    async handler(ctx, input) {
      return readSitePreview(ctx, siteId(input));
    },
  },
];
