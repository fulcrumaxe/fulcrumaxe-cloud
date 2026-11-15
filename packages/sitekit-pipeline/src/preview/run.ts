import { ProductKind, type ClaimType } from "@fx/sitekit-claims";
import { assertRepoCoordinates, ExtractError, runExtract, type ExtractDeps, type SeedFile } from "../extract/index.js";
import { buildReport, runVerify, type RepoReader } from "../verify/index.js";
import {
  EXTRACT_SHARE_USD,
  SITEKIT_PREVIEW_COMPUTE_CAP_USD,
  SITEKIT_PREVIEW_DAILY_COMPUTE_CAP_USD,
  SITEKIT_PREVIEW_MODEL_CAP_USD,
} from "./constants.js";
import { NOTHING_SPENT_CODES, PreviewError, type PreviewCode } from "./errors.js";
import { previewSeedFiles } from "./seed.js";
import { summarize, type PreviewSummary } from "./summary.js";

/** Where a failure that must not change the preview's outcome is reported. */
export type PreviewReportStage = "delete_sandbox" | "settle" | "release" | "compute_settle" | "compute_release" | "store_finish" | "store_read" | "store_start" | "run";

export type FinishOutcome =
  | { state: "finished"; claimsTotal: number; claimsUnverifiable: number; blockers: number; homepageHtml: string }
  | { state: "failed"; reason: PreviewCode }
  | { state: "void"; reason: PreviewCode };

/** The preview row, as the three database functions of migration 1019 expose it. */
export interface PreviewStore {
  /** Today's site-kit preview compute across accounts (`sitekit_preview_daily_compute_usd()`). */
  dailyComputeUsd(): Promise<number>;
  /** requested to running; false when the preview is not in the requested state. */
  start(previewId: string): Promise<boolean>;
  /** Ends the preview. `failed` keeps the one-time stamp; `void` hands it back, and is only for a run whose agent never started. */
  finish(previewId: string, outcome: FinishOutcome): Promise<boolean>;
}

/** The sandbox compute a preview reserves under the purpose 'sitekit_preview'. */
export interface ComputePort {
  reserve(p: { accountId: string; previewId: string; capUsd: number }): Promise<{ ok: true; reservationId: string } | { ok: false }>;
  settle(reservationId: string, usedUsd: number): Promise<void>;
  release(reservationId: string): Promise<void>;
}

export interface PreviewDeps extends Omit<ExtractDeps, "report"> {
  store: PreviewStore;
  compute: ComputePort;
  /** Reads the cited files at the pinned sha, the same reader the full verify pass takes. The preview confirms every excerpt too; it never skips that check. */
  repo: RepoReader;
  /** The homepage as HTML, from the verified claims. The template's own gate decides what it may show. */
  renderHomepage(claims: readonly ClaimType[], sha: string): string;
  now(): Date;
  report(stage: PreviewReportStage, err: unknown): void;
}

export interface PreviewInput {
  accountId: string;
  /** The `sitekit_previews` row this run is for. */
  previewId: string;
  owner: string;
  name: string;
  sha: string;
  productKind: ProductKind;
  /** What the customer confirmed. The run refuses unless it is exactly the cap. */
  confirmModelCapUsd: number;
  /** The README and top-level documentation text; anything deeper is dropped. */
  seed: readonly SeedFile[];
}

export type PreviewOutcome =
  | { status: "finished"; summary: PreviewSummary; homepageHtml: string; usedUsd: number; cleanupFailed: string[] }
  | { status: "failed" | "void" | "refused"; code: PreviewCode; cleanupFailed: string[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_HTML_CHARS = 1_000_000;

/**
 * One site-kit preview: the extract pass, then one verify pass, read only, on the customer's key and within the cap they
 * confirmed. In order: the cap is checked against the exact number (a refusal before anything is touched), the day's
 * counter, the $1 compute reservation, then the preview row goes to running and the two passes run (their own order is
 * `runSandboxedPass`'s: the network is narrowed before an agent can start, and once one has started its spend is settled,
 * never released).
 *
 * The one-time stamp follows the same rule as the money. A run that ends before any agent started spent nothing, so the
 * preview is voided and the stamp handed back; a run that started an agent and then failed, in any way, is `failed` and
 * the stamp stays. Cleanup that throws (the compute settlement, the final write) is reported through `deps.report` and
 * listed in `cleanupFailed`; it never replaces the outcome. Failures carry a fixed code and no repository, agent,
 * adapter or database text.
 */
export async function runSitePreview(deps: PreviewDeps, input: PreviewInput): Promise<PreviewOutcome> {
  if (input.confirmModelCapUsd !== SITEKIT_PREVIEW_MODEL_CAP_USD) throw new PreviewError("cap_not_confirmed");
  if (!UUID_RE.test(input.previewId) || !ID_RE.test(input.accountId) || !ProductKind.safeParse(input.productKind).success) throw new PreviewError("input_invalid");
  try {
    assertRepoCoordinates(input.owner, input.name, input.sha);
  } catch {
    throw new PreviewError("input_invalid");
  }
  const cleanupFailed: string[] = [];
  const reportable: ExtractDeps["report"] = (stage, err) => deps.report(stage, err);

  const finish = async (outcome: FinishOutcome): Promise<void> => {
    try {
      await deps.store.finish(input.previewId, outcome);
    } catch (err) {
      // fx-swallow-ok: reported and flagged in cleanupFailed; the write failing never replaces the preview's own outcome
      cleanupFailed.push("store_finish");
      deps.report("store_finish", err);
    }
  };

  let used: number;
  try {
    used = await deps.store.dailyComputeUsd();
  } catch (err) {
    // fx-swallow-ok: reported through deps.report; the run is refused with a fixed code
    deps.report("store_read", err);
    return { status: "refused", code: "run_failed", cleanupFailed };
  }
  if (!Number.isFinite(used) || used >= SITEKIT_PREVIEW_DAILY_COMPUTE_CAP_USD) {
    await finish({ state: "void", reason: "capacity" });
    return { status: "void", code: "capacity", cleanupFailed };
  }
  const computeHold = await deps.compute.reserve({ accountId: input.accountId, previewId: input.previewId, capUsd: SITEKIT_PREVIEW_COMPUTE_CAP_USD }).catch(() => ({ ok: false as const }));
  if (!computeHold.ok) {
    await finish({ state: "void", reason: "capacity" });
    return { status: "void", code: "capacity", cleanupFailed };
  }
  const settleCompute = async (agentMayHaveStarted: boolean): Promise<void> => {
    try {
      if (agentMayHaveStarted) await deps.compute.settle(computeHold.reservationId, SITEKIT_PREVIEW_COMPUTE_CAP_USD);
      else await deps.compute.release(computeHold.reservationId);
    } catch (err) {
      // fx-swallow-ok: reported and flagged in cleanupFailed; compute bookkeeping never replaces the preview's own outcome
      const stage = agentMayHaveStarted ? "compute_settle" : "compute_release";
      cleanupFailed.push(stage);
      deps.report(stage, err);
    }
  };
  let started = false;
  try {
    started = await deps.store.start(input.previewId);
  } catch (err) {
    // fx-swallow-ok: reported through deps.report; a preview that cannot be started runs nothing
    deps.report("store_start", err);
    started = false;
  }
  if (!started) {
    await settleCompute(false);
    return { status: "refused", code: "not_requested", cleanupFailed };
  }

  let spent = false; // an agent has been started and its spend settled
  try {
    const passDeps: ExtractDeps = { ...deps, report: reportable };
    const extracted = await runExtract(passDeps, {
      accountId: input.accountId,
      runId: `${input.previewId}-x`,
      owner: input.owner,
      name: input.name,
      sha: input.sha,
      productKind: input.productKind,
      mode: "full",
      capUsd: EXTRACT_SHARE_USD,
      seed: previewSeedFiles(input.seed),
      shallow: true,
    });
    spent = true;
    cleanupFailed.push(...extracted.cleanupFailed);
    const remaining = SITEKIT_PREVIEW_MODEL_CAP_USD - extracted.usedUsd;
    if (!(remaining > 0)) throw new PreviewError("over_cap");
    const verified = await runVerify({ ...passDeps, repo: deps.repo }, {
      accountId: input.accountId,
      runId: `${input.previewId}-v`,
      extractorRunId: `${input.previewId}-x`,
      owner: input.owner,
      name: input.name,
      sha: input.sha,
      mode: "full",
      capUsd: remaining,
      claims: extracted.claims,
      checkedAt: deps.now().toISOString(),
    });
    cleanupFailed.push(...verified.cleanupFailed);
    const report = buildReport(verified.claims, [], { sha: input.sha, verifierRunId: `${input.previewId}-v` });
    const summary = summarize(report);
    let html: string;
    try {
      html = deps.renderHomepage(verified.claims, input.sha);
      if (typeof html !== "string" || html.length === 0 || html.length > MAX_HTML_CHARS) throw new Error("bad render");
    } catch {
      throw new PreviewError("render_failed");
    }
    await settleCompute(true);
    await finish({ state: "finished", claimsTotal: summary.claims, claimsUnverifiable: summary.unverifiable, blockers: summary.blockers, homepageHtml: html });
    return { status: "finished", summary, homepageHtml: html, usedUsd: extracted.usedUsd + verified.usedUsd, cleanupFailed };
  } catch (err) {
    // fx-swallow-ok: a refusal has a fixed code and anything else is reported through deps.report; both end in the outcome below
    const known = err instanceof ExtractError || err instanceof PreviewError;
    if (!known) deps.report("run", err); // a refusal carries a fixed code and is not an incident; anything else is reported
    const code: PreviewCode = known ? err.code : "run_failed";
    // Only an extract-pass refusal before any agent started, with nothing spent before it, is a run that spent nothing.
    const nothingSpent = !spent && err instanceof ExtractError && NOTHING_SPENT_CODES.has(code);
    await settleCompute(!nothingSpent);
    await finish(nothingSpent ? { state: "void", reason: code } : { state: "failed", reason: code });
    return { status: nothingSpent ? "void" : "failed", code, cleanupFailed };
  }
}
