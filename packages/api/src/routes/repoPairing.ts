import { z } from "zod";
import { clearRepoPairing, getRepoPairing, MAX_OVERLAY_GLOBS, setRepoPairing, type RepoPairing } from "@fx/core/src/repos/pairing.js";
import type { RouteEntry } from "../registry.js";

const pairingResponseSchema = z.object({
  /** False when the repo has no pairing row: the default, and what a repo that never opted in reads as. */
  enabled: z.boolean(),
  code_repo: z.string().nullable(),
  overlay_globs: z.array(z.string()),
  identifier_rules_path: z.string().nullable(),
  plan_data_rules_path: z.string().nullable(),
  /** The public pull request body footer template; null when none (the default). */
  pr_footer: z.string().nullable(),
});

const repoIdParamsSchema = z.object({ id: z.string() });

/** Strict, and a full replace: an unknown key is a 422. Both rule-file paths are optional; omitted or null means none declared. */
const putPairingBodySchema = z
  .object({
    code_repo: z.string(),
    overlay_globs: z.array(z.string()).max(MAX_OVERLAY_GLOBS),
    identifier_rules_path: z.string().nullable().optional(),
    plan_data_rules_path: z.string().nullable().optional(),
    pr_footer: z.string().nullable().optional(),
  })
  .strict();

function toItem(p: RepoPairing): z.infer<typeof pairingResponseSchema> {
  return {
    enabled: p.enabled,
    code_repo: p.codeRepo,
    overlay_globs: p.overlayGlobs,
    identifier_rules_path: p.identifierRulesPath,
    plan_data_rules_path: p.planDataRulesPath,
    pr_footer: p.prFooter ?? null,
  };
}

/** Repo pairing: read (member), set and clear (owner/admin, session only: a token may never change where code is pushed). */
export const repoPairingRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/repos/{id}/pairing",
    operationId: "getRepoPairing",
    summary: "A repo's paired public code repo, or enabled false when it has none",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: repoIdParamsSchema,
    responseSchema: pairingResponseSchema,
    async handler(ctx, input) {
      return toItem(await getRepoPairing({ pool: ctx.pool, principal: ctx.principal }, input.params.id!));
    },
  },
  {
    method: "PUT",
    path: "/api/v1/repos/{id}/pairing",
    operationId: "putRepoPairing",
    summary: "Pair a repo with a public code repo, or replace its pairing (changes only items started afterwards)",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: repoIdParamsSchema,
    bodySchema: putPairingBodySchema,
    responseSchema: pairingResponseSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof putPairingBodySchema>;
      return toItem(
        await setRepoPairing({ pool: ctx.pool, principal: ctx.principal }, input.params.id!, {
          codeRepo: body.code_repo,
          overlayGlobs: body.overlay_globs,
          identifierRulesPath: body.identifier_rules_path,
          planDataRulesPath: body.plan_data_rules_path,
          prFooter: body.pr_footer,
        }),
      );
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/repos/{id}/pairing",
    operationId: "deleteRepoPairing",
    summary: "Remove a repo's pairing; new items use the single-repo path and public PRs already open stay open",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: repoIdParamsSchema,
    responseSchema: z.null(),
    successStatus: 204,
    async handler(ctx, input) {
      await clearRepoPairing({ pool: ctx.pool, principal: ctx.principal }, input.params.id!);
      return null;
    },
  },
];
