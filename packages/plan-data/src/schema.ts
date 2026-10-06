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
  })
  .strict();

export type PlanData = z.infer<typeof planDataSchema>;
