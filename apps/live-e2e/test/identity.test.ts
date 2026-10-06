import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { BYPASS_ENV } from "../src/needs.js";
import type { Executor } from "../src/run.js";
import { identityGuard, isProdSafe, readDeploymentIdentity } from "../src/targets.js";
import { healthViolations } from "../packs/platform/expected.js";
import { makeIo, makePack, makeTarget, scratchRoot, tmpDir } from "./helpers.js";

const staging = makeTarget();
const SECRET = "t5b-bypass-secret-value";

/** A fake origin that answers `/api/health` like the app does, and records what it was asked. */
function fakeHealth(body: unknown, status = 200) {
  const seen: { url: string; bypass: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), bypass: headers.get("x-vercel-protection-bypass") });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("layer 2: identityGuard", () => {
  it("passes only for deploy_env staging AND the staging project id", () => {
    expect(identityGuard({ deploy_env: "staging", project_id: "prj_Staging1" }, staging)).toBeNull();
  });

  it("refuses a mis-set FX_DEPLOY_ENV alone: staging claimed, another project", () => {
    expect(identityGuard({ deploy_env: "staging", project_id: "prj_Production1" }, staging)).toBe("layer2-project-id-mismatch");
  });

  it("refuses the right project id with another deploy_env", () => {
    for (const deploy_env of ["production", "local", "Staging", null, undefined, 1]) {
      expect(identityGuard({ deploy_env, project_id: "prj_Staging1" }, staging), String(deploy_env)).toBe("layer2-deploy-env-not-staging");
    }
  });

  it("fails closed on a missing, blank or non-string field and on an unreadable origin", () => {
    expect(identityGuard({ deploy_env: "staging" }, staging)).toBe("layer2-project-id-missing");
    expect(identityGuard({ deploy_env: "staging", project_id: null }, staging)).toBe("layer2-project-id-missing");
    expect(identityGuard({ deploy_env: "staging", project_id: "" }, staging)).toBe("layer2-project-id-missing");
    expect(identityGuard({ deploy_env: "staging", project_id: 7 }, staging)).toBe("layer2-project-id-missing");
    expect(identityGuard({}, staging)).toBe("layer2-deploy-env-not-staging");
    expect(identityGuard(null, staging)).toBe("layer2-identity-unreadable");
  });

  it("is only ever compared with the staging target's project id", () => {
    expect(identityGuard({ deploy_env: "staging", project_id: "prj_Production1" }, makeTarget({ name: "production", project_id: "prj_Production1" }))).toBe("layer2-not-staging-target");
  });
});

describe("layer 2: reading the origin", () => {
  it("reads deploy_env and project_id from the exact origin, with the bypass header", async () => {
    const { fetchImpl, seen } = fakeHealth({ ok: true, deploy_env: "staging", project_id: "prj_Staging1", commit: "abc" });
    expect(await readDeploymentIdentity(staging, SECRET, fetchImpl)).toEqual({ deploy_env: "staging", project_id: "prj_Staging1" });
    expect(seen).toEqual([{ url: "https://staging.example.test/api/health", bypass: SECRET }]);
  });

  it("reads a 503 body too: an incomplete config still says who it is", async () => {
    const { fetchImpl } = fakeHealth({ ok: false, deploy_env: "staging", project_id: "prj_Staging1" }, 503);
    expect(await readDeploymentIdentity(staging, SECRET, fetchImpl)).toMatchObject({ project_id: "prj_Staging1" });
  });

  it("never follows a redirect: an off-origin 302 to a host that answers as staging reads as unreadable", async () => {
    const seen: string[] = [];
    const notStaging = makeTarget({ origin: "https://not-staging.example.test" });
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith("https://not-staging.example.test/")) return new Response(null, { status: 302, headers: { location: "https://staging.example.test/api/health" } });
      return new Response(JSON.stringify({ deploy_env: "staging", project_id: "prj_Staging1" }), { status: 200 });
    }) as typeof fetch;
    const identity = await readDeploymentIdentity(notStaging, SECRET, fetchImpl);
    expect(identity).toBeNull();
    expect(identityGuard(identity, staging)).toBe("layer2-identity-unreadable");
    expect(seen).toEqual(["https://not-staging.example.test/api/health"]);
  });

  it("refuses a same-origin redirect too: any 3xx is unreadable", async () => {
    for (const status of [301, 302, 307, 308]) {
      const seen: string[] = [];
      const fetchImpl = (async (input: string | URL | Request) => {
        seen.push(String(input));
        return new Response(null, { status, headers: { location: "https://staging.example.test/health2" } });
      }) as typeof fetch;
      expect(await readDeploymentIdentity(staging, SECRET, fetchImpl), String(status)).toBeNull();
      expect(seen).toHaveLength(1);
    }
  });

  it("gives null for a wall, a non-JSON body, a non-object body and a network error", async () => {
    expect(await readDeploymentIdentity(staging, SECRET, fakeHealth({}, 401).fetchImpl)).toBeNull();
    expect(await readDeploymentIdentity(staging, SECRET, fakeHealth("<html>").fetchImpl)).toBeNull();
    expect(await readDeploymentIdentity(staging, SECRET, fakeHealth([1]).fetchImpl)).toBeNull();
    const boom = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    expect(await readDeploymentIdentity(staging, SECRET, boom)).toBeNull();
  });
});

describe("isProdSafe", () => {
  it("is a non-destructive pack that lists production", () => {
    expect(isProdSafe(makePack({ id: "a", targets: ["staging", "production"] }))).toBe(true);
    expect(isProdSafe(makePack({ id: "b", targets: ["staging"] }))).toBe(false);
    expect(isProdSafe(makePack({ id: "c", targets: ["staging", "production"], destructive: true }))).toBe(false);
  });
});

describe("layer 2 in `run`", () => {
  const stagingOnly = makePack({ id: "stg-only" });
  const safe = makePack({ id: "safe", targets: ["staging", "production"] });
  const okBody = { ok: true, deploy_env: "staging", project_id: "prj_Staging1", commit: "abc" };

  async function run(packs: ReturnType<typeof makePack>[], fetchImpl: typeof fetch, args: string[]) {
    const dir = tmpDir();
    const { io, err } = makeIo(scratchRoot(packs), { [BYPASS_ENV]: SECRET });
    io.cwd = dir;
    io.fetch = fetchImpl;
    const ran: string[] = [];
    const exec: Executor = async (inv) => {
      ran.push(inv.packId);
      return { code: 0, output: "" };
    };
    io.exec = exec;
    const code = await main(["run", "--target", "staging", ...args], io);
    return { code, ran, err, plan: JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as { packs: { id: string; outcome: string; reason?: string }[] } };
  }

  it("runs a pack that is not prod-safe when the origin is the staging deployment", async () => {
    const { code, ran } = await run([stagingOnly], fakeHealth(okBody).fetchImpl, ["--pack", "stg-only"]);
    expect([code, ran]).toEqual([0, ["stg-only"]]);
  });

  it("refuses it, and runs nothing, when the origin says production or another project", async () => {
    for (const body of [{ ...okBody, deploy_env: "production" }, { ...okBody, project_id: "prj_Production1" }, { ok: true }]) {
      const { code, ran, plan, err } = await run([stagingOnly], fakeHealth(body).fetchImpl, ["--pack", "stg-only"]);
      expect(ran).toEqual([]);
      expect(code).toBe(1);
      expect(plan.packs[0]).toMatchObject({ id: "stg-only", outcome: "REFUSED" });
      expect(plan.packs[0]?.reason).toMatch(/^layer2-/);
      expect(err.join("\n")).toContain("REFUSED layer2-");
    }
  });

  it("refuses it when the origin cannot be read", async () => {
    const { ran, plan } = await run([stagingOnly], fakeHealth("nope").fetchImpl, ["--pack", "stg-only"]);
    expect(ran).toEqual([]);
    expect(plan.packs[0]?.reason).toBe("layer2-identity-unreadable");
  });

  it("does not ask, and does not refuse, a prod-safe pack", async () => {
    const { fetchImpl, seen } = fakeHealth({ ok: true, deploy_env: "production" });
    const { code, ran } = await run([safe], fetchImpl, ["--pack", "safe"]);
    expect([code, ran, seen]).toEqual([0, ["safe"], []]);
  });

  it("refuses only the pack that is not prod-safe when both are selected", async () => {
    const { ran, plan } = await run([stagingOnly, safe], fakeHealth({ ok: true, deploy_env: "production" }).fetchImpl, ["--pack", "stg-only,safe"]);
    expect(ran).toEqual(["safe"]);
    expect(plan.packs.map((p) => [p.id, p.outcome])).toEqual([["safe", "RUN"], ["stg-only", "REFUSED"]]);
  });

  it("sends the bypass secret to the identity read only when the target is protected", async () => {
    for (const isProtected of [true, false]) {
      const root = scratchRoot([stagingOnly]);
      const file = join(root, "targets", "staging.json");
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), protected: isProtected }));
      const { io } = makeIo(root, { [BYPASS_ENV]: SECRET });
      io.cwd = tmpDir();
      const { fetchImpl, seen } = fakeHealth(okBody);
      io.fetch = fetchImpl;
      io.exec = async () => ({ code: 0, output: "" });
      expect(await main(["run", "--target", "staging", "--pack", "stg-only"], io)).toBe(0);
      expect(seen.map((s) => s.bypass), String(isProtected)).toEqual([isProtected ? SECRET : null]);
    }
  });

  it("`plan` stays offline: it never reads the origin", async () => {
    const { fetchImpl, seen } = fakeHealth({});
    const { io } = makeIo(scratchRoot([stagingOnly]), { [BYPASS_ENV]: SECRET });
    io.cwd = tmpDir();
    io.fetch = fetchImpl;
    expect(await main(["plan", "--target", "staging", "--pack", "stg-only"], io)).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe("platform P3 expectation for /api/health", () => {
  const stg = { name: "staging", project_id: "prj_Staging1" };
  const prod = { name: "production", project_id: "prj_Production1" };

  it("staging: identity present and matching", () => {
    const body = { ok: true, config: "ok", planData: "ok", deploy_env: "staging", project_id: "prj_Staging1", commit: "abc" };
    expect(healthViolations(body, stg)).toEqual([]);
    expect(healthViolations({ ...body, commit: null }, stg)).toEqual([]);
    expect(healthViolations({ ...body, project_id: "prj_Other" }, stg)).not.toEqual([]);
    expect(healthViolations({ ...body, deploy_env: "production" }, stg)).not.toEqual([]);
  });

  it("production: deploy_env only, and a leaked project id or commit is a violation", () => {
    const body = { ok: true, config: "ok", planData: "missing", deploy_env: "production" };
    expect(healthViolations(body, prod)).toEqual([]);
    expect(healthViolations({ ...body, project_id: "prj_Production1" }, prod)).not.toEqual([]);
    expect(healthViolations({ ...body, commit: "abc" }, prod)).not.toEqual([]);
  });

  it("the old shape (no deploy_env) fails on both targets", () => {
    const old = { ok: true, config: "ok", planData: "ok" };
    expect(healthViolations(old, stg)).not.toEqual([]);
    expect(healthViolations(old, prod)).not.toEqual([]);
  });
});
