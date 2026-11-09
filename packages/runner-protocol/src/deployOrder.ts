import { z } from "zod";

/**
 * The deploy order: the cloud's record that a merged commit should be deployed by a runner on the repository's own machine, and the two signed calls by
 * which that runner takes it and reports. THE CLOUD CAN ONLY SAY "DEPLOY SHA X OF REPOSITORY R". The command that does the deploy lives in the runner's own
 * local configuration and is never part of any message, reply or row: no field here can hold a command, an argument, a path, a URL or a credential
 * (test/deployOrder.test.ts walks the schemas), so a compromised cloud cannot make a runner execute anything it was not set up to run for that repository.
 *
 *   hint     the claim reply (any 200) carries `deploy_order: true` when an order waits for this runner and its latest hello listed `deploy_order_v1`
 *            (replies.ts). A runner without the capability is never sent the key: its strict parse would refuse it.
 *   claim    POST /api/runner/deploy-order-claim: the oldest order this runner may take, leased for DEPLOY_ORDER_LEASE_SECONDS, with the repository and the sha.
 *   report   POST /api/runner/deploy-order-report: what happened, a closed result and code, the exit status and the last lines of output the runner chose to send.
 *
 * Everything the runner sends back is a HINT about its own machine. The order's row, the lease generation and the runner named by the signature are the
 * cloud's own; the report names the order and the generation it was given and nothing else about the order.
 */
export const DEPLOY_ORDER_CLAIM_PATH = "/api/runner/deploy-order-claim";
export const DEPLOY_ORDER_REPORT_PATH = "/api/runner/deploy-order-report";

/** A claim leases the order to one runner for this long; a runner that is gone lets the lease lapse and the order can be taken again. */
export const DEPLOY_ORDER_LEASE_SECONDS = 1200;
/** An order is claimed at most this many times (the attempts column). */
export const DEPLOY_ORDER_MAX_ATTEMPTS = 3;

/** Why a deploy did not succeed, a closed set. `not_configured`: this runner holds no deploy command for the repository. `script_refused`: its command or script failed the runner's own checks. */
export const DEPLOY_ORDER_FAILURE_CODES = ["not_configured", "script_refused", "spawn_failed", "exit_nonzero", "timeout"] as const;
export const DeployOrderFailureCode = z.enum(DEPLOY_ORDER_FAILURE_CODES);
export type DeployOrderFailureCode = z.infer<typeof DeployOrderFailureCode>;

/** The last lines of output a report may carry, after the runner scrubbed secrets: at most this many lines, each at most this many characters. */
export const MAX_DEPLOY_OUTPUT_TAIL_LINES = 20;
export const MAX_DEPLOY_OUTPUT_LINE_CHARS = 200;

const gitSha = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/);
const safeInt = z.number().int().safe();
const retryAfter = (max: number) => safeInt.min(1).max(max);
const utcTimestamp = z.string().datetime();

/** One output line: no control or format character (so no newline either), no lone surrogate, bounded. It is data to show, never text to act on. */
const outputLine = z
  .string()
  .max(MAX_DEPLOY_OUTPUT_LINE_CHARS)
  .regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]*$/u)
  .refine((line) => new TextDecoder().decode(new TextEncoder().encode(line)) === line, { message: "a line is well-formed text" });

/** A claim carries nothing: the signature names the runner and the cloud picks the oldest order this runner may take. */
export const DeployOrderClaimMessage = z.object({}).strict();
export type DeployOrderClaimMessage = z.infer<typeof DeployOrderClaimMessage>;

/**
 * What the runner did. `succeeded` goes with exit status 0 and no failure code; `failed` goes with a failure code, and `exit_nonzero` is the one code with
 * an exit status (1 to 255). The output lines are optional and bounded.
 */
export const DeployOrderReportMessage = z
  .object({
    order_id: z.string().uuid(),
    lease_generation: safeInt.min(1),
    result: z.enum(["succeeded", "failed"]),
    exit_code: safeInt.min(0).max(255).optional(),
    failure_code: DeployOrderFailureCode.optional(),
    output_tail: z.array(outputLine).max(MAX_DEPLOY_OUTPUT_TAIL_LINES).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.result === "succeeded") {
      if (m.failure_code !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a success carries no failure code", path: ["failure_code"] });
      if (m.exit_code !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a success carries exit status 0", path: ["exit_code"] });
      return;
    }
    if (m.failure_code === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a failure names its code", path: ["failure_code"] });
    if ((m.failure_code === "exit_nonzero") !== (m.exit_code !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "an exit status goes with exit_nonzero, and only with it", path: ["exit_code"] });
    if (m.failure_code === "exit_nonzero" && m.exit_code === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exit_nonzero is not exit status 0", path: ["exit_code"] });
  });
export type DeployOrderReportMessage = z.infer<typeof DeployOrderReportMessage>;

/**
 * 200 from deploy-order-claim: the order and the two facts the runner needs, from the cloud's rows: which repository and which commit. Nothing else; in
 * particular no command, no URL and no credential. Or `{ retry_after }` when nothing waits for this runner.
 */
export const DeployOrderClaimedReply = z
  .object({
    order_id: z.string().uuid(),
    lease_generation: safeInt.min(1),
    lease_expires_at: utcTimestamp,
    repo: z.object({ owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/), name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/) }).strict(),
    sha: gitSha,
  })
  .strict();
export const DeployOrderClaimReply = z.union([DeployOrderClaimedReply, z.object({ retry_after: retryAfter(3600) }).strict()]);
export type DeployOrderClaimReply = z.infer<typeof DeployOrderClaimReply>;

/** 200 from deploy-order-report: understood. What the cloud recorded is read from its own rows. */
export const DeployOrderReportReply = z.object({ recorded: z.literal(true) }).strict();
export type DeployOrderReportReply = z.infer<typeof DeployOrderReportReply>;
