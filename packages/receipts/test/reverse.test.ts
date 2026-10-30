import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOGUE } from "@fx/decisions";
import {
  NO_MERGED_PR_REASON,
  UNKNOWN_TYPE_REASON,
  defaultReversalPricePort,
  loadReversalPricePort,
  planReversal,
  unavailableRetractionPort,
  type BuildState,
  type PricedReceipt,
  type ReversalPlan,
} from "../src/index.js";
import { fakeBuildState, fakeGit, fakeLedger, fakeRetraction } from "./fakes.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(40);
const T0 = Date.UTC(2026, 9, 1, 12);
const HOUR = 3_600_000;
const now = () => new Date(T0 + 10 * HOUR);
const PR = { number: 7, headSha: SHA };

const STATES: Record<string, BuildState> = {
  not_started: { stage: "not_started", pr: null },
  building: { stage: "building", pr: null },
  built: { stage: "built", pr: PR },
  merged: { stage: "merged", pr: PR },
};
const inWindow = new Date(T0 + 24 * HOUR);
const pastWindow = new Date(T0 + 1 * HOUR);

const receipt = (decisionType: string, reversalFreeUntil: Date | null): PricedReceipt => ({ decisionType, createdAt: new Date(T0), reversalFreeUntil });

describe("planReversal: criterion 1, every catalogue entry answers within its declared availability", () => {
  for (const entry of CATALOGUE) {
    for (const [name, state] of Object.entries(STATES)) {
      for (const [win, until] of [["inside the window", inWindow], ["past the window", pastWindow], ["no window", null]] as const) {
        it(`${entry.id} / ${name} / ${win}`, () => {
          const plan = planReversal(receipt(entry.id, until), state, now);
          const a = entry.reversal;
          if (a.availability === "not_reversible") {
            expect(plan).toEqual({ kind: "refused", reason: a.reason });
          } else if (a.availability === "compensating_work") {
            expect(plan).toEqual({ kind: "compensating_work" });
          } else {
            expect(["free_redecide", "rerun", "revert_pr"]).toContain(plan.kind);
          }
        });
      }
    }
  }

  it("the catalogue has all three availabilities and every not_reversible entry carries a reason", () => {
    const kinds = new Set(CATALOGUE.map((e) => e.reversal.availability));
    expect([...kinds].sort()).toEqual(["compensating_work", "not_reversible", "reversible_before_build"]);
    for (const e of CATALOGUE) if (e.reversal.availability === "not_reversible") expect(e.reversal.reason.length).toBeGreaterThan(0);
  });

  it("a reversible entry follows the window and the build: free inside the window or before the build, a re-run in between, a revert after merge", () => {
    const id = CATALOGUE.find((e) => e.reversal.availability === "reversible_before_build")!.id;
    const plan = (state: string, until: Date | null): ReversalPlan => planReversal(receipt(id, until), STATES[state]!, now);
    expect(plan("built", inWindow)).toEqual({ kind: "free_redecide" });
    expect(plan("merged", inWindow)).toEqual({ kind: "free_redecide" });
    expect(plan("not_started", pastWindow)).toEqual({ kind: "free_redecide" });
    expect(plan("building", pastWindow)).toEqual({ kind: "rerun", pr: null });
    expect(plan("built", pastWindow)).toEqual({ kind: "rerun", pr: PR });
    expect(plan("merged", pastWindow)).toEqual({ kind: "revert_pr", pr: PR });
    expect(plan("merged", null)).toEqual({ kind: "revert_pr", pr: PR });
    expect(planReversal(receipt(id, pastWindow), { stage: "merged", pr: null }, now)).toEqual({ kind: "refused", reason: NO_MERGED_PR_REASON });
  });

  it("the end of the window is inclusive, matching the price port", () => {
    const id = CATALOGUE.find((e) => e.reversal.availability === "reversible_before_build")!.id;
    expect(planReversal(receipt(id, now()), STATES.built!, now).kind).toBe("free_redecide");
    expect(planReversal(receipt(id, new Date(now().getTime() - 1)), STATES.built!, now).kind).toBe("rerun");
  });

  it("a type the catalogue does not know is refused with a fixed reason", () => {
    expect(planReversal(receipt("no_such_type", inWindow), STATES.built!, now)).toEqual({ kind: "refused", reason: UNKNOWN_TYPE_REASON });
  });
});

describe("planReversal: criterion 2, irreversible effects are refused, not attempted", () => {
  it("spend (retry_transient_step_failure) is refused with the entry's own reason, unchanged, and no write port is touched", () => {
    const git = fakeGit({ open: { "acme/widgets#7": SHA }, merged: ["acme/widgets#7"] });
    const retraction = fakeRetraction();
    const entry = CATALOGUE.find((e) => e.id === "retry_transient_step_failure")!;
    const plan = planReversal(receipt(entry.id, inWindow), STATES.merged!, now);
    expect(plan).toEqual({ kind: "refused", reason: entry.reversal.availability === "not_reversible" ? entry.reversal.reason : "" });
    expect(git.writes).toEqual([]);
    expect(retraction.writes).toEqual([]);
  });

  it("planReversal takes no port, so no plan can call a writer", () => {
    expect(planReversal.length).toBe(3);
  });

  it("a published artefact (publish_deprecation_notice) plans as compensating work, and the default RetractionPort answers unavailable and writes nothing", async () => {
    expect(planReversal(receipt("publish_deprecation_notice", pastWindow), STATES.merged!, now)).toEqual({ kind: "compensating_work" });
    await expect(unavailableRetractionPort.retractDeprecationNotice({ surface: "release", ref: "v1" })).resolves.toEqual({ ok: false, code: "unavailable" });
    await expect(unavailableRetractionPort.retractDeprecationNotice({ surface: "discussion", ref: "d1" })).resolves.toEqual({ ok: false, code: "unavailable" });
  });
});

describe("loadReversalPricePort: criterion 3, the three price cases", () => {
  const reversible = CATALOGUE.find((e) => e.reversal.availability === "reversible_before_build")!.id;
  const notReversible = CATALOGUE.find((e) => e.reversal.availability === "not_reversible")!.id;
  const load = (spend: Record<string, number>) => loadReversalPricePort(fakeLedger(spend), ACCOUNT, ITEM, now);

  const SPENT = { [`${ACCOUNT}:${ITEM}`]: 3.25 };
  it.each([
    ["inside the window: free_until", SPENT, reversible, inWindow, { kind: "free_until", until: inWindow }],
    ["after the window: the ledger sum", SPENT, reversible, pastWindow, { kind: "estimate", usd: 3.25 }],
    ["after the window with nothing spent: an estimate of zero, not a waiver", {}, reversible, pastWindow, { kind: "estimate", usd: 0 }],
    ["no recorded deadline: the ledger sum", SPENT, reversible, null, { kind: "estimate", usd: 3.25 }],
    ["a not_reversible entry: unavailable", SPENT, notReversible, pastWindow, { kind: "unavailable" }],
  ] as const)("%s", async (_label, spend, id, until, expected) => {
    const port = await load({ ...spend });
    expect(port.priceFor(receipt(id, until))).toEqual(expected);
  });

  it("reads the ledger exactly once, however many receipts are priced", async () => {
    const ledger = fakeLedger({ [`${ACCOUNT}:${ITEM}`]: 1 });
    const port = await loadReversalPricePort(ledger, ACCOUNT, ITEM, now);
    for (let i = 0; i < 5; i++) port.priceFor(receipt(reversible, pastWindow));
    expect(ledger.reads).toEqual([[ACCOUNT, ITEM]]);
  });

  it("a misclassification carries no money: the price shape has no credit, refund or waived kind, and a flag on the receipt changes nothing", async () => {
    const port = await load({ [`${ACCOUNT}:${ITEM}`]: 2 });
    const flagged = { ...receipt(reversible, pastWindow), misclassified: true } as PricedReceipt;
    expect(port.priceFor(flagged)).toEqual(port.priceFor(receipt(reversible, pastWindow)));
    const out = JSON.stringify([port.priceFor(flagged), port.priceFor(receipt(reversible, inWindow))]);
    expect(out).not.toMatch(/credit|refund|waive|discount/i);
    const src = readFileSync(fileURLToPath(new URL("../src/price.ts", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/credit|refund|waive|discount/i);
  });
});

describe("criterion 6: DP6a's default binding is still the only binding when no loader is passed", () => {
  const src = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");

  it("the block writer and the renderer take their price port from the caller and never name the loader or an adapter", () => {
    for (const f of ["block.ts", "render.ts", "markers.ts"]) {
      expect(src(f), f).not.toMatch(/loadReversalPricePort|adapters\/|createLedgerPort|createBuildStatePort/);
    }
    expect(src("block.ts")).toMatch(/price: ReversalPricePort;/);
    expect(src("block.ts")).not.toMatch(/price\?:/);
  });

  it("the loader is referenced from price.ts and index.ts only", () => {
    for (const f of ["block.ts", "render.ts", "markers.ts", "ports.ts", "reverse.ts"]) expect(src(f), f).not.toMatch(/loadReversalPricePort/);
    expect(src("index.ts")).toMatch(/loadReversalPricePort/);
  });

  it("defaultReversalPricePort never answers estimate, for any entry, state of the window or time", () => {
    for (const e of CATALOGUE) {
      for (const until of [null, inWindow, pastWindow]) {
        expect(defaultReversalPricePort(now).priceFor(receipt(e.id, until)).kind).not.toBe("estimate");
      }
    }
  });

  it("fakeBuildState and the planner agree on the shapes (a built item carries its pull request)", async () => {
    const port = fakeBuildState({ [`${ACCOUNT}:${ITEM}`]: STATES.built! });
    expect(planReversal(receipt("run_extension", pastWindow), await port.stateOf(ACCOUNT, ITEM), now).kind).toMatch(/rerun|free_redecide|compensating_work|refused/);
  });
});
