import type { Plan } from "@fx/env-build";
import type { BuildOutcome, EnsurePorts, EnvStore, NewVersion, Reservation, RunCtx, VersionRecord } from "../src/index.js";
import { CTX, NET, digest } from "./fakes.js";

export interface BuildRow {
  id: string;
  envVersionId: string;
  budget: string;
  status: "running" | "succeeded" | "failed" | "killed";
  failingStep?: string;
  logRef?: string;
  costUsd: number;
}

/** Postgres' unique violation, as the `pg` driver reports it. The real insert path rejects a repeat the same way. */
class UniqueViolation extends Error {
  readonly code = "23505";
}

export interface World {
  /** repo file text by commit; absent key = no file at that commit. */
  files: Record<string, string>;
  proposal: string | null;
  reserveAnswer: Reservation;
  buildAnswer: (plan: Plan) => BuildOutcome | Promise<BuildOutcome>;
}

/** Every call any port receives, in order, so a test can assert what did and did not happen. */
export function makeEnsure(over: Partial<World> = {}) {
  const w: World = {
    files: {}, proposal: null, reserveAnswer: { ok: true, id: "resv-1", reservedUsd: 1.5 },
    buildAnswer: () => ({ ok: true, builtImageDigest: digest("e"), costUsd: 0.2, logRef: "log-1" }), ...over,
  };
  const calls: string[] = [];
  const versions = new Map<string, VersionRecord & { source: string; repoId: string }>();
  const builds: BuildRow[] = [];
  const built: Plan[] = [];
  const settled: { id: string; costUsd: number }[] = [];
  const insertAttempts: NewVersion[] = [];

  const store: EnvStore = {
    async getVersion(repoId, id) {
      calls.push("store.getVersion");
      const v = versions.get(`${repoId}/${id}`);
      return v ?? null;
    },
    async insertVersion(repoId, v) {
      calls.push("store.insertVersion");
      insertAttempts.push(v);
      const key = `${repoId}/${v.envVersionId}`;
      if (versions.has(key)) throw new UniqueViolation("duplicate key value violates unique constraint");
      if (!/^[0-9a-f]{64}$/.test(v.envVersionId)) throw new Error("env_version_id check");
      versions.set(key, { ...v, repoId });
    },
    async startBuild(envVersionId, budget) {
      calls.push("store.startBuild");
      if (!/^[0-9a-f]{64}$/.test(envVersionId)) throw new Error("env_builds.env_version_id check violated");
      const row: BuildRow = { id: `b-${builds.length + 1}`, envVersionId, budget, status: "running", costUsd: 0 };
      builds.push(row);
      return { id: row.id };
    },
    async finishBuild(buildId, o) {
      calls.push("store.finishBuild");
      const row = builds.find((b) => b.id === buildId)!;
      if (row.status !== "running") return; // a build closes once
      row.status = o.status;
      if (o.failingStep !== undefined) row.failingStep = o.failingStep;
      if (o.logRef !== undefined) row.logRef = o.logRef;
      row.costUsd = o.costUsd;
    },
  };

  const ports: EnsurePorts = {
    async readRepoFile(ctx: RunCtx, path) {
      calls.push("readRepoFile");
      return path === ".fulcrumaxe/env.yaml" ? (w.files[ctx.commitSha] ?? null) : null;
    },
    async readProposal() {
      calls.push("readProposal");
      return w.proposal;
    },
    networkContext: () => NET,
    store,
    async reserve() {
      calls.push("reserve");
      return w.reserveAnswer;
    },
    async build(_ctx, plan) {
      calls.push("build");
      built.push(plan);
      return w.buildAnswer(plan);
    },
    async settle(id, costUsd) {
      calls.push("settle");
      settled.push({ id, costUsd });
    },
  };
  return { w, ports, calls, versions, builds, built, settled, insertAttempts, ctx: CTX };
}
