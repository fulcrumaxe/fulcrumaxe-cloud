import type { Pool } from "pg";
import { defaultReversalPricePort, writeReceiptBlock, type BlockHttp, type BlockMeasurement, type ReversalPricePort } from "@fx/receipts";
import { readItemPullNumber } from "@fx/core/src/work-items/stackParentPull.js";
import type { AfterReceiptHook } from "@fx/core/src/decisions/receiptHook.js";
import { listReceiptsForWorkItem } from "@fx/db/src/decisions.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { InstallationHttpError } from "@fx/github";

/**
 * D#7 DP6a-WIRING: the caller of `writeReceiptBlock`. After a decision receipt has committed for a work item, this puts the item's class-2 receipts into the
 * receipt block of the item's open pull request, and measures the write against that head's CI (C22 B3, reading b).
 *
 * Where each input comes from: the repository and the pull request NUMBER come from the platform's own rows for the item (`work_items.repo_id` and the number its
 * runs recorded, the rule the activity view uses), never from a receipt or from text a model wrote. The client opened for it is pinned to that one number (the
 * `receipt_block` token purpose and `installationHttp` kind, which allow a PATCH whose only key is `body` and a head's check-run list, nothing else). The receipts
 * come from `decision_receipts` through the tenant's own RLS. The block text is fixed words, option ids and times: no rationale or ask text reaches it.
 *
 * Best-effort by contract: the function never throws, and no failure undoes or delays the decision (the caller runs it after the commit). Every outcome is one
 * fixed code on one log line; GitHub's text, a path, a token or a repository name is never logged. No timer, queue or poll: each call is made by the write
 * that just committed, so a receipt reaches the block on the next write and a closed pull request simply stops being written to.
 */
export type ReceiptBlockCode =
  | "written"
  | "unchanged"
  | "no_work_item"
  | "no_repository"
  | "no_pull_request"
  | "no_class2_receipts"
  | "pr_not_open"
  | "block_unplaceable"
  | "pr_unreadable"
  | "pr_write_refused"
  | "check_runs_unreadable"
  | "app_not_installed"
  | "github_unavailable"
  | "db_unavailable";

export interface ReceiptBlockOutcome {
  code: ReceiptBlockCode;
  /** Set when the block was written or found current: the CI measurement of C22 B3. Recorded, not a pass/fail threshold. */
  measurement?: BlockMeasurement;
}

/** What the web app supplies: a client for the `receipt_block` purpose, pinned to the repository and the one pull request. */
export type OpenReceiptBlockHttp = (target: { repoId: string; owner: string; name: string; prNumber: number }) => Promise<BlockHttp & { close?: () => Promise<void> }>;

export interface ReceiptBlockDeps {
  /** A pool on which `withTenant` can read the tenant's receipts, work items, repositories and runs (the receipt login's pool is one). */
  pool: Pool;
  connect: OpenReceiptBlockHttp;
  /** One JSON line per outcome. */
  log: (line: string) => void;
  now?: () => Date;
  /** DP7 replaces this binding without changing anything here. */
  price?: ReversalPricePort;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createReceiptBlockRefresher(deps: ReceiptBlockDeps): { refresh(input: { accountId: string; workItemId: string }): Promise<ReceiptBlockOutcome>; hook: AfterReceiptHook } {
  const now = deps.now ?? (() => new Date());
  const price = deps.price ?? defaultReversalPricePort(now);

  const say = (o: ReceiptBlockOutcome): ReceiptBlockOutcome => {
    const m = o.measurement;
    try {
      deps.log(
        JSON.stringify({
          event: "decision.receipt_block",
          code: o.code,
          ...(m ? { check_runs: m.checkRuns, lag_ms: m.lagMs, before_ci_finished: m.beforeCiFinished, miss: m.miss } : {}),
        }),
      );
    } catch {
      // fx-swallow-ok: a logger that throws must not turn a best-effort write into a failure
    }
    return o;
  };

  async function refresh(input: { accountId: string; workItemId: string }): Promise<ReceiptBlockOutcome> {
    try {
      if (!UUID_RE.test(input.accountId) || !UUID_RE.test(input.workItemId)) return say({ code: "no_work_item" });
      let facts;
      try {
        facts = await withTenant(deps.pool, input.accountId, async (client) => {
          const item = (await client.query<{ repo_id: string | null; owner: string | null; name: string | null }>(
            `SELECT w.repo_id, r.gh_owner AS owner, r.gh_name AS name
               FROM work_items w LEFT JOIN repos r ON r.id = w.repo_id AND r.account_id = w.account_id
              WHERE w.id = $1::uuid AND w.account_id = $2::uuid`,
            [input.workItemId, input.accountId],
          )).rows[0];
          if (!item) return { code: "no_work_item" as const };
          if (item.repo_id === null || item.owner === null || item.name === null || !OWNER_RE.test(item.owner) || !NAME_RE.test(item.name)) return { code: "no_repository" as const };
          const receipts = await listReceiptsForWorkItem(client, input.workItemId);
          if (!receipts.some((r) => r.class === "human_over_the_loop")) return { code: "no_class2_receipts" as const };
          const prNumber = await readItemPullNumber(client, input.workItemId);
          if (prNumber === null) return { code: "no_pull_request" as const };
          return { code: "ready" as const, repoId: item.repo_id, owner: item.owner, name: item.name, prNumber, receipts };
        });
      } catch {
        // fx-swallow-ok: a failed read is one fixed code; the decision already committed
        return say({ code: "db_unavailable" });
      }
      if (facts.code !== "ready") return say({ code: facts.code });

      let http: Awaited<ReturnType<OpenReceiptBlockHttp>>;
      try {
        http = await deps.connect({ repoId: facts.repoId, owner: facts.owner, name: facts.name, prNumber: facts.prNumber });
      } catch (err) {
        // fx-swallow-ok: classified into a fixed code below; the error's text can carry a host or an installation id
        return say({ code: err instanceof InstallationHttpError && err.reason === "no_installation" ? "app_not_installed" : "github_unavailable" });
      }
      try {
        const res = await writeReceiptBlock({
          http,
          owner: facts.owner,
          name: facts.name,
          prNumber: facts.prNumber,
          receipts: facts.receipts.map((r) => ({
            id: r.id,
            class: r.class,
            decisionType: r.decisionType,
            chosen: r.chosen,
            rejectedAlternative: r.rejectedAlternative,
            dialVersion: r.dialVersion,
            actor: r.actor,
            createdAt: r.createdAt,
            reversalFreeUntil: r.reversalFreeUntil,
            reversalState: r.reversalState,
          })),
          price,
          now,
        });
        if (!res.written) return say({ code: res.reason });
        return say({ code: res.changed ? "written" : "unchanged", measurement: res.measurement });
      } catch {
        // fx-swallow-ok: a transport failure or a client refusal is one fixed code; nothing of it is logged
        return say({ code: "github_unavailable" });
      } finally {
        await http.close?.().catch(() => undefined);
      }
    } catch {
      // fx-swallow-ok: the last guard of a best-effort function; the decision stands
      return { code: "github_unavailable" };
    }
  }

  return {
    refresh,
    hook: async (input) => {
      await refresh(input);
    },
  };
}
