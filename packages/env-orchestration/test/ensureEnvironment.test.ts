import { describe, expect, it } from "vitest";
import { ensureEnvironment, type EnsuredEnvironment } from "../src/index.js";
import { digest } from "./fakes.js";
import { makeEnsure } from "./ensureFakes.js";

const NODE = "version: 1\npreset: node\n";
const PY = "version: 1\npreset: python\n";

/** The shape the runner's `ensureEnv` hook accepts, written out here because the runner is not a dependency of this package. */
type RunnerRunEnvironment =
  | { kind: "none" }
  | { kind: "ready"; envVersionId: string; imageDigest: string }
  | { kind: "error"; file: string; step: string; message: string };

const ready = (r: EnsuredEnvironment) => {
  if (r.kind !== "ready") throw new Error(`expected ready, got ${JSON.stringify(r)}`);
  return r;
};

describe("the result binds to the runner's ensureEnv hook", () => {
  it("is assignable to the runner's RunEnvironment", async () => {
    const t = makeEnsure({ files: { c1: NODE } });
    const hook: () => Promise<RunnerRunEnvironment> = () => ensureEnvironment(t.ports, t.ctx);
    expect((await hook()).kind).toBe("ready");
  });
});

describe("criterion 1: the repo file at the run's commit wins; the proposal fills in only when there is none", () => {
  it("with both present, the file is used and the proposal is never read", async () => {
    const t = makeEnsure({ files: { c1: NODE }, proposal: PY });
    const r = ready(await ensureEnvironment(t.ports, t.ctx));
    expect(JSON.parse([...t.versions.values()][0]!.canonicalSpec).preset).toEqual(["node"]);
    expect([...t.versions.values()][0]!.source).toBe("repo");
    expect(t.calls).not.toContain("readProposal");
    expect(r.imageDigest).toBe(digest("e"));
  });

  it("with only the proposal, the proposal is used and recorded as such", async () => {
    const t = makeEnsure({ proposal: PY });
    ready(await ensureEnvironment(t.ports, t.ctx));
    expect(JSON.parse([...t.versions.values()][0]!.canonicalSpec).preset).toEqual(["python"]);
    expect([...t.versions.values()][0]!.source).toBe("proposal");
  });

  it("a broken repo file is an error even when a good proposal exists: the proposal does not paper over it", async () => {
    const t = makeEnsure({ files: { c1: "version: 1\npreset: nope\n" }, proposal: NODE });
    const r = await ensureEnvironment(t.ports, t.ctx);
    expect(r).toMatchObject({ kind: "error", file: ".fulcrumaxe/env.yaml", step: "parse_config" });
    expect(t.calls).not.toContain("readProposal");
    expect(t.built).toEqual([]);
  });

  it("neither file nor proposal: no environment, nothing written", async () => {
    const t = makeEnsure();
    expect(await ensureEnvironment(t.ports, t.ctx)).toEqual({ kind: "none" });
    expect(t.builds).toEqual([]);
    expect(t.calls).toEqual(["readRepoFile", "readProposal"]);
  });
});

describe("criterion 2: two commits of one repo with different configs give two env_version_ids", () => {
  it("each run reads the file at its own commit", async () => {
    const t = makeEnsure({ files: { c1: NODE, c2: PY } });
    const a = ready(await ensureEnvironment(t.ports, { ...t.ctx, commitSha: "c1" }));
    const b = ready(await ensureEnvironment(t.ports, { ...t.ctx, commitSha: "c2" }));
    expect(a.envVersionId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.envVersionId).not.toBe(b.envVersionId);
    expect(t.built.length).toBe(2);
  });

  it("two commits with the same config share one version", async () => {
    const t = makeEnsure({ files: { c1: NODE, c2: NODE } });
    const a = ready(await ensureEnvironment(t.ports, { ...t.ctx, commitSha: "c1" }));
    const b = ready(await ensureEnvironment(t.ports, { ...t.ctx, commitSha: "c2" }));
    expect(a.envVersionId).toBe(b.envVersionId);
  });
});

describe("criterion 3: a cache hit skips the build; a miss builds under the reservation", () => {
  it("the second run of the same version builds nothing and reserves nothing", async () => {
    const t = makeEnsure({ files: { c1: NODE } });
    const first = ready(await ensureEnvironment(t.ports, t.ctx));
    const callsAfterFirst = t.calls.length;
    const second = ready(await ensureEnvironment(t.ports, t.ctx));
    expect(second).toEqual(first);
    const later = t.calls.slice(callsAfterFirst);
    expect(later).not.toContain("build");
    expect(later).not.toContain("reserve");
    expect(later).not.toContain("store.startBuild");
    expect(t.built.length).toBe(1);
    expect(t.builds.length).toBe(1);
  });

  it("a miss reserves before building, builds the planned image, stores the version with both digests, and settles", async () => {
    const t = makeEnsure({ files: { c1: NODE } });
    const r = ready(await ensureEnvironment(t.ports, t.ctx));
    expect(t.calls).toEqual([
      "readRepoFile", "store.getVersion", "store.startBuild", "reserve", "build", "store.insertVersion", "store.finishBuild", "store.getVersion", "settle",
    ]);
    expect(t.built[0]!.envVersionId).toBe(r.envVersionId);
    const v = [...t.versions.values()][0]!;
    expect(v.builtImageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(v.baseImageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(t.builds[0]).toMatchObject({ envVersionId: r.envVersionId, budget: "foreground_compute", status: "succeeded", costUsd: 0.2, logRef: "log-1" });
    expect(t.settled).toEqual([{ id: "resv-1", costUsd: 0.2 }]);
  });

  it("the budget on the build row is the one the run draws on", async () => {
    const t = makeEnsure({ files: { c1: NODE } });
    ready(await ensureEnvironment(t.ports, { ...t.ctx, budget: "background_compute" }));
    expect(t.builds[0]!.budget).toBe("background_compute");
  });

  it("a refused reservation builds nothing, closes the row at step reserve, and returns an environment error", async () => {
    const t = makeEnsure({ files: { c1: NODE }, reserveAnswer: { ok: false, reason: "monthly cap reached" } });
    const r = await ensureEnvironment(t.ports, t.ctx);
    expect(r).toMatchObject({ kind: "error", step: "reserve" });
    expect(t.calls).not.toContain("build");
    expect(t.builds[0]).toMatchObject({ status: "failed", failingStep: "reserve" });
    expect(t.settled).toEqual([]);
    expect(t.versions.size).toBe(0);
  });

  it("two runs racing to the same version: the loser's insert hits the unique violation and takes the winner's row", async () => {
    const t = makeEnsure({ files: { c1: NODE } });
    // The winner stored its version between this run's cache check and its insert.
    const realBuild = t.ports.build;
    t.ports.build = async (ctx, plan, resv) => {
      t.versions.set(`${ctx.repoId}/${plan.envVersionId}`, {
        envVersionId: plan.envVersionId, builtImageDigest: digest("1"), baseImageDigest: digest("2"), canonicalSpec: "{}", source: "repo", repoId: ctx.repoId,
      });
      return realBuild(ctx, plan, resv);
    };
    const r = ready(await ensureEnvironment(t.ports, t.ctx));
    expect(r.imageDigest).toBe(digest("1"));
    expect(t.builds[0]!.status).toBe("succeeded");
    expect(t.settled.length).toBe(1);
  });
});

describe("criterion 4: a failed ensure-env emits no run events, writes an env_builds row with the failing step, and names file and step", () => {
  /** No port can write a run event; the call log proves the step touched only these, and that it ended in a failed row. */
  const ALLOWED = ["readRepoFile", "readProposal", "store.getVersion", "store.startBuild", "store.finishBuild", "store.insertVersion", "reserve", "build", "settle"];

  it("a build that fails at a step", async () => {
    const t = makeEnsure({
      files: { c1: NODE },
      buildAnswer: () => ({ ok: false, status: "failed", step: "layer:node", costUsd: 0.1, logRef: "log-9" }),
    });
    const r = await ensureEnvironment(t.ports, t.ctx);
    expect(r).toMatchObject({ kind: "error", file: ".fulcrumaxe/env.yaml", step: "layer:node" });
    expect((r as { message: string }).message).toContain(".fulcrumaxe/env.yaml");
    expect((r as { message: string }).message).toContain("layer:node");
    expect(t.builds).toEqual([expect.objectContaining({ status: "failed", failingStep: "layer:node", logRef: "log-9", costUsd: 0.1 })]);
    expect(t.versions.size).toBe(0);
    expect(t.settled).toEqual([{ id: "resv-1", costUsd: 0.1 }]);
    expect(t.calls.every((c) => ALLOWED.includes(c))).toBe(true);
    expect(t.calls.filter((c) => /event/i.test(c)).length).toBe(0);
  });

  it("a build killed at its cap is recorded as killed, with the step it was in", async () => {
    const t = makeEnsure({ files: { c1: NODE }, buildAnswer: () => ({ ok: false, status: "killed", step: "layer:node", costUsd: 0.5 }) });
    const r = await ensureEnvironment(t.ports, t.ctx);
    expect(r).toMatchObject({ kind: "error", step: "layer:node" });
    expect(t.builds[0]).toMatchObject({ status: "killed", failingStep: "layer:node", costUsd: 0.5 });
  });

  it("a builder that throws still ends in an error result, a closed row and a settled reservation", async () => {
    const t = makeEnsure({ files: { c1: NODE }, buildAnswer: () => { throw new Error("socket hang up"); } });
    const r = await ensureEnvironment(t.ports, t.ctx);
    expect(r).toMatchObject({ kind: "error", step: "build" });
    expect(JSON.stringify(r)).not.toContain("socket hang up");
    expect(t.builds[0]).toMatchObject({ status: "failed", failingStep: "build" });
    expect(t.settled.length).toBe(1);
  });

  it("a builder that throws settles the reservation at its full reserved amount and records that amount on the row", async () => {
    const t = makeEnsure({ files: { c1: NODE }, reserveAnswer: { ok: true, id: "resv-7", reservedUsd: 1.5 }, buildAnswer: () => { throw new Error("socket hang up"); } });
    await ensureEnvironment(t.ports, t.ctx);
    expect(t.settled).toEqual([{ id: "resv-7", costUsd: 1.5 }]);
    expect(t.builds[0]!.costUsd).toBe(1.5);
  });

  it("a build that returns settles at its reported cost, below the reservation", async () => {
    const t = makeEnsure({ files: { c1: NODE }, reserveAnswer: { ok: true, id: "resv-8", reservedUsd: 1.5 } });
    await ensureEnvironment(t.ports, t.ctx);
    expect(t.settled).toEqual([{ id: "resv-8", costUsd: 0.2 }]);
    expect(t.builds[0]!.costUsd).toBe(0.2);
  });

  it("a file that does not parse writes a failed row at parse_config, builds and reserves nothing", async () => {
    const t = makeEnsure({ files: { c1: "version: 1\npreset: nope\n" } });
    const r = await ensureEnvironment(t.ports, t.ctx);
    expect(r).toMatchObject({ kind: "error", file: ".fulcrumaxe/env.yaml", step: "parse_config" });
    expect(t.builds).toEqual([expect.objectContaining({ status: "failed", failingStep: "parse_config" })]);
    expect(t.builds[0]!.envVersionId).toMatch(/^[0-9a-f]{64}$/);
    expect(t.calls).not.toContain("reserve");
    expect(t.calls).not.toContain("build");
    expect(t.calls.every((c) => ALLOWED.includes(c))).toBe(true);
  });

  it("a spec the planner cannot build yet (a dockerfile) fails at step plan with the planner's own reason", async () => {
    const t = makeEnsure({ files: { c1: "version: 1\ndockerfile: Dockerfile\n" } });
    const r = await ensureEnvironment(t.ports, t.ctx);
    expect(r).toMatchObject({ kind: "error", step: "plan" });
    expect((r as { message: string }).message).toContain("dockerfile_source_not_planned");
    expect(t.builds[0]).toMatchObject({ status: "failed", failingStep: "plan" });
    expect(t.calls).not.toContain("reserve");
  });

  it("two different broken files land on different keys", async () => {
    const t = makeEnsure({ files: { c1: "version: 1\npreset: nope\n", c2: "version: 1\npreset: other\n" } });
    await ensureEnvironment(t.ports, t.ctx);
    await ensureEnvironment(t.ports, { ...t.ctx, commitSha: "c2" });
    expect(t.builds).toHaveLength(2);
    expect(t.builds[0]!.envVersionId).not.toBe(t.builds[1]!.envVersionId);
  });

  it("the same broken file lands on the same key every time", async () => {
    const t = makeEnsure({ files: { c1: "version: 1\npreset: nope\n" } });
    await ensureEnvironment(t.ports, t.ctx);
    await ensureEnvironment(t.ports, t.ctx);
    expect(t.builds[0]!.envVersionId).toBe(t.builds[1]!.envVersionId);
  });
});

describe("criterion 5: the version and digest returned are what the run row records", () => {
  it("a miss returns the stored built digest; a hit returns the same pair", async () => {
    const t = makeEnsure({ files: { c1: NODE } });
    const miss = ready(await ensureEnvironment(t.ports, t.ctx));
    const hit = ready(await ensureEnvironment(t.ports, t.ctx));
    expect(miss.imageDigest).toBe(digest("e"));
    expect(hit).toEqual(miss);
    expect(miss.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
