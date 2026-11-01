import { z } from 'zod';

/**
 * The shape of the plan data. Shape only: no real figure lives in this package.
 * Every object is strict, so an unknown key is an error rather than silently ignored.
 */
const usd = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();

const flatBudget = z.object({ kind: z.literal('flat'), usdPerMonth: usd }).strict();
const scalingBudget = z
  .object({
    kind: z.literal('scaling'),
    baseUsdPerMonth: usd,
    perRepoUsdPerMonth: usd,
    ceilingUsdPerMonth: usd,
  })
  .strict();

const planSchema = z
  .object({
    foreground: flatBudget,
    background: z.discriminatedUnion('kind', [flatBudget, scalingBudget]),
    repoLimit: count.nullable(),
    alwaysOnSecurityReviewer: z.boolean(),
    priorityQueue: z.boolean(),
    priceUsdPerMonth: usd,
    computeCapUsdPerMonth: usd,
    apiLimits: z.object({ perTokenPerMinute: count, perTenantPerMinute: count }).strict(),
    webhookEndpointLimit: count,
    /** Concurrent token-authenticated event streams one account may hold on this plan. */
    tokenStreamsPerTenant: count,
    /** Assumed monthly volume, used only for the role-settings cost estimate. */
    monthlyWorkload: z.object({ features: count, smalls: count }).strict(),
    /**
     * D#605 FL-12a: the local-runner figures of a hosted plan. `maxRunners` is the most active runners an account may hold;
     * `defaultAccountJobs` and `defaultPerRepoJobs` are the runner jobs the account may have running at once, in all and on one
     * repository, until an owner or admin raises them. Optional so data that predates it still loads; a caller that needs it
     * gets an "unavailable" answer, never a default (the claim hands out nothing and register answers 503).
     */
    runners: z
      .object({ maxRunners: count.positive(), defaultAccountJobs: count.positive(), defaultPerRepoJobs: count.positive() })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The runner tier (D#6): a plan for customers who run the agent on their own machine. It is not one of the three
 * subscription plans above (those carry the Stripe price mapping and the rate limits), so it sits beside them and is
 * optional: data that predates it still loads, and a caller that needs it gets an "unavailable" answer, never a default.
 * Every figure is provisional until the owner fixes the tier; `source` says where it came from.
 */
const runnerPlanSchema = z
  .object({
    foreground: flatBudget,
    background: flatBudget,
    limits: z
      .object({
        maxRunners: count,
        maxConcurrentRunnerJobs: count,
        /** D#6 C43-2b: how many of those may be heavy (builds and full test runs). Optional: data that predates it loads, and the claim reads a missing figure as 1 (fail closed). */
        maxConcurrentHeavyRunnerJobs: count.optional(),
        runsPerDay: count,
        maxRunWallClockMs: count,
        fullClonesPerRepoPerDay: count,
        previews: z.boolean(),
      })
      .strict(),
    provisional: z.boolean(),
    source: z.string().min(1),
  })
  .strict();

const modelRate = z
  .object({
    inputUsdPerMTok: usd,
    outputUsdPerMTok: usd,
    cacheWriteUsdPerMTok: usd,
    cacheReadUsdPerMTok: usd,
    reasoningUsdPerMTok: usd.optional(),
    cacheRatesProvisional: z.boolean().optional(),
    /** D#600 CX-6a: the model's context window in tokens (200,000 for every claude model today). Optional: data that predates it loads, and a model without it gets no context warning (there is no default). */
    contextWindowTokens: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();

const sourcedModelRate = modelRate
  .extend({ sourceUrl: z.string().min(1), fetchedAt: z.string().min(1) })
  .strict();

export const planDataSchema = z
  .object({
    /** True only in the public fixture. The loader refuses it in production. */
    fixture: z.boolean().optional(),
    plans: z.object({ starter: planSchema, team: planSchema, scale: planSchema }).strict(),
    runnerPlan: runnerPlanSchema.optional(),
    pricing: z
      .object({
        fetchedAt: z.string().min(1),
        claude: z.object({ 'haiku-4.5': modelRate, 'sonnet-5': modelRate, 'opus-5': modelRate }).strict(),
        openai: z.object({ 'gpt-5.3-codex': sourcedModelRate }).strict(),
        sandbox: z
          .object({ cpuUsdPerHour: usd, memUsdPerGbHour: usd, dataTransferUsdPerGb: usd })
          .strict(),
      })
      .strict(),
    /** Seed median cost of one run by model tier, until a tenant's own ledger medians replace it. */
    medianCostPerRunSeedUsd: z.object({ haiku: usd, sonnet: usd, opus: usd }).strict(),
    caps: z.object({ perSpawnUsd: usd, featureUsd: usd, smallUsd: usd, maxFixRounds: count }).strict(),
    /**
     * D#483 S5-e1: the default margin an envelope adds to the priced estimate, in percent (0 to 500, the same bound the margin setting will have).
     * Optional: data that predates it loads, and a missing figure means the pre-fill is the bare estimate (fail closed, never a made-up margin).
     */
    envelope: z.object({ defaultMarginPct: z.number().finite().min(0).max(500) }).strict().optional(),
    /**
     * D#483 S4-b: the discovery and verification limits. Optional, and a missing block means discovery and verification are OFF for every
     * repo (fail closed, reported as `discovery_unconfigured`); no figure has a default. `perRepoDailyUsd` caps one repo's discovery and
     * verifier spend per day, `verifyPerProposalUsd` is the most one verification may reserve, and `externalVerifiesPerRepoPerDay` is how
     * many proposals from outside authors one repo may have checked in a day (0 checks none). D#483 S4-f3: `analysisPerRunUsd` (optional) is the most one
     * docs-and-code analysis run may reserve; without it analysis is OFF (`analysis_unconfigured`) and verification is unaffected.
     */
    discovery: z
      .object({
        perRepoDailyUsd: z.number().finite().positive(),
        verifyPerProposalUsd: z.number().finite().positive(),
        externalVerifiesPerRepoPerDay: count,
        analysisPerRunUsd: z.number().finite().positive().optional(),
      })
      .strict()
      .optional(),
    /**
     * D#483 S5-k3b: how many sandboxes our hosted sandbox plan lets run at once (the provider's concurrent-sandbox limit). Optional so data that predates it
     * loads; the reader throws when it is missing, there is no number in code to fall back to. `provisional` and `source` say where the figure came from.
     */
    capacity: z
      .object({ hostedSandboxConcurrency: z.number().int().positive(), provisional: z.boolean(), source: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export type PlanData = z.infer<typeof planDataSchema>;
