import { validateRegistry, type RouteEntry } from "../registry.js";
import { accountRoutes } from "./account.js";
import { runRoutes } from "./runs.js";
import { workItemRoutes } from "./work-items.js";
import { workItemPriorityRoutes } from "./work-item-priority.js";
import { tokenRoutes } from "./tokens.js";
import { statsRoutes } from "./stats.js";
import { workItemActivityRoutes } from "./work-item-activity.js";
import { runInsightRoutes } from "./run-insight.js";
import { webhookEndpointRoutes } from "./webhook-endpoints.js";
import { eventRoutes } from "./events.js";
import { modelConnectionRoutes } from "./model-connection.js";
import { repoRoutes } from "./repos.js";
import { roleRoutes } from "./roles.js";
import { githubRoutes } from "./github.js";
import { billingRoutes } from "./billing.js";
import { runLimitRoutes } from "./run-limits.js";
import { auditLogRoutes } from "./audit-log.js";
import { runActionRoutes } from "./run-actions.js";
import { workItemActionRoutes } from "./work-item-actions.js";
import { onboardingRoutes } from "./onboarding.js";
import { runEventsExportRoutes } from "./runEventsExport.js";
import { commentRoutes, discussionRoutes } from "./discussions.js";
import { siteRoutes } from "./sites.js";
import { sitekitBillingRoutes } from "./sitekitBilling.js";
import { planRoutes } from "./plan.js";

/**
 * The one array every other piece of API-1 reads from: the catch-all's
 * dispatch table (`handler.ts`), the OpenAPI document (`openapi.ts`),
 * and the inventory test. A new resource is one module in
 * `packages/api/src/routes/` plus one line here.
 *
 * API-1c adds the first entry (`GET /api/v1/account`); every task after
 * that keeps extending this same array. D#31 API-3a adds `runRoutes` and
 * `workItemRoutes` (runs and work-item reads). API-3b adds `tokenRoutes`.
 * D#45 S3 adds `statsRoutes` (`GET /stats`, `GET /work-items/{id}/timeline`).
 * D#31 API-4b adds `webhookEndpointRoutes`. D#31 API-5 adds `eventRoutes`
 * (the JSON half of the two event streams; the SSE half is the two route
 * files under apps/web/app/api/v1/). D#31 API-2 adds `modelConnectionRoutes`.
 * D#31 API-8a adds `repoRoutes` and `roleRoutes`. API-8c adds `githubRoutes`.
 * API-7a adds `billingRoutes` (usage and budgets reads).
 * API-8d adds `runLimitRoutes` (run limits read and set).
 * API-7b adds `auditLogRoutes`. API-6a-2 adds `runActionRoutes`.
 * D#45 S8a adds `runEventsExportRoutes` (the per-run NDJSON download).
 * D#483 P4 adds `workItemActivityRoutes` (what the pipeline is doing for one work item); P5 adds `runInsightRoutes`.
 */
export const ROUTES: RouteEntry[] = [
  ...accountRoutes,
  ...runRoutes,
  ...workItemRoutes,
  ...workItemPriorityRoutes,
  ...tokenRoutes,
  ...statsRoutes,
  ...workItemActivityRoutes,
  ...workItemActionRoutes,
  ...runInsightRoutes,
  ...webhookEndpointRoutes,
  ...eventRoutes,
  ...modelConnectionRoutes,
  ...repoRoutes,
  ...roleRoutes,
  ...githubRoutes,
  ...billingRoutes,
  ...runLimitRoutes,
  ...auditLogRoutes,
  ...runActionRoutes,
  ...onboardingRoutes,
  ...runEventsExportRoutes,
  ...discussionRoutes,
  ...commentRoutes,
  ...siteRoutes,
  ...sitekitBillingRoutes,
  ...planRoutes,
];

// Fails fast (at import time, so both the test suite and `next start`
// itself refuse to boot) if any startsRun:true entry ever lists 'token'.
validateRegistry(ROUTES);
