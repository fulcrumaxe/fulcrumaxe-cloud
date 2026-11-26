import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.join(packagesDir, "..");

/**
 * D#587 B-7a: what a runner reports about its sandboxes and its host limits (the inventory, its last-seen time, `max_vms`, `max_vcpus`, `max_memory_mb`,
 * the bootable templates) is a claim by a semi-trusted machine. It may order or narrow routing and it may be shown; no decision about who may do what reads it.
 *
 * The guard is a closed list: the only source files that may name any of these identifiers are the ones listed below, each for a stated reason. A new reader
 * anywhere in a package or the web app fails here until a person adds it to the list, and a file on a security path can never be added (the second test).
 */
const NAMES = /runner_sandboxes|runner_sandbox_reports|runner_sandbox_facts_record|runner_sandboxes_record|runner_sandbox_session|max_vms|max_vcpus|max_memory_mb|bootable_templates|snapshot_age_s|SandboxInventoryRow|InventorySource|InventoryReporter|inventoryHash|inventoryFingerprint/;

/** The files allowed to name them, relative to the repository root. */
const ALLOWED: Record<string, string> = {
  "packages/runner-protocol/src/messages.ts": "the schema of the claim block and of the hello facts",
  "packages/runner-cloud/src/hello.ts": "stores the host limits through the definer",
  "packages/runner-cloud/src/claim.ts": "stores the inventory through the definer; nothing in the claim's decisions reads it back",
  "packages/runner-cloud/src/heartbeat.ts": "stores the inventory a held run's heartbeat carries through the definer; nothing in the heartbeat's decisions reads it back",
  "packages/fx-runner/src/daemon/sandboxInventory.ts": "the runner's reporter and the inventory source",
  "packages/fx-runner/src/daemon/client.ts": "puts the block on the claim and on the heartbeat",
  "packages/fx-runner/src/commands/run.ts": "wires the default source",
  "packages/fx-runner/src/commands/doctor.ts": "the runner's own local microvm caps (runnerSettings), not the cloud inventory tables",
  "packages/fx-runner/src/vm/limits.ts": "the runner's own local microvm caps (runnerSettings), not the cloud inventory tables",
  "packages/fx-runner/src/vm/installPlan.ts": "writes the helper's own root-owned config on this machine: the default limits and the config keys; it makes no decision from a limit and reads no cloud inventory",
  "packages/fx-runner/src/vm/install.ts": "prints the plan's default limits (max_vcpus among them) to the person running the install; it decides nothing from a limit and reads no cloud inventory",
  "packages/db/migrations/1040_runner_sandbox_inventory.sql": "creates the tables and the two definers; the only migration that may name them",
  "packages/runner-cloud/src/fleetSandboxes.ts": "display-only reader for the fleet page: the sandboxes, their last-seen time and the host limits; computes no permission from them",
  "packages/db/migrations/1068_engine_session_sandboxes.sql": "the engine_session_sandboxes view over the inventory: display and routing facts of an engine session, no permission read from it",
  "packages/db/migrations/1077_engine_system_stops.sql": "the system-stop list reads the inventory to pick which sessions a plan end or an off stops (is the engine's sandbox up, has the machine reported since the last stop): the safe direction, no gate (coverage, operate, role) reads it",
  "packages/db/migrations/1100_engine_system_start.sql": "the system first start reads the inventory for one hint only: whether the engine's sandbox is listed (the signed start's `resume` flag, which the machine re-checks); no gate reads it, the gates are coverage, operate and the cause",
  "packages/db/migrations/1105_engine_operate_queue.sql": "the `operate_on` start list reads the inventory for the same one hint as 1100 (the signed start's `resume` flag, which the machine re-checks), and the issuer it restates carries 1100's own copy of that hint; no gate reads it, the gates are coverage, operate and the cause",
  "packages/runner-cloud/src/engineSession.ts":"reads the inventory for two hints only: whether an engine's sandbox is listed (the signed start's `resume` flag, which the machine re-checks) and which engines are up (the set a stop is issued for, the safe direction); no gate (coverage, operate, role) reads it",
  "packages/fx-runner/src/vm/sandboxd/management.ts": "the daemon's own inventory and lifecycle views for the runner's sandbox reporter; reads the daemon's table, computes no permission from it",
};

/** Paths on which a request is verified, a job or a ticket is signed, a repository or credential is granted: none may name the inventory or the limits. */
const SECURITY_PATHS = [
  "packages/runner-cloud/src/verifyRunnerRequest.ts",
  "packages/runner-cloud/src/strictEd25519.ts",
  "packages/runner-cloud/src/gitTicket.ts",
  "packages/runner-cloud/src/register.ts",
  "packages/runner-cloud/src/revoke.ts",
  "packages/runner-cloud/src/rotate.ts",
  "packages/runner-cloud/src/provisioningTokens.ts",
  "packages/runner-cloud/src/engineCommands.ts",
  "packages/runner-cloud/src/planePush.ts",
  "packages/runner-cloud/src/planeMerge.ts",
  "packages/runner-cloud/src/fleetControls.ts",
  "packages/worker/src/jobSigner.ts",
  "packages/worker/src/gitTicketSigner.ts",
  "packages/worker/src/runnerClaims.ts",
  "packages/worker/src/runnerRouting.ts",
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "test" || name === "dist" || name === ".next") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|js|mjs|sql)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const rel = (file: string): string => path.relative(repoRoot, file).split(path.sep).join("/");

describe("no security decision reads the sandbox inventory or the host limits", () => {
  it("only the listed files name them, in every package source, every application and every migration", () => {
    const roots = readdirSync(packagesDir).map((p) => path.join(packagesDir, p, "src"));
    // Every application, whole (not only apps/web), and every migration: a view or a policy over these tables would be a reader too.
    for (const app of readdirSync(path.join(repoRoot, "apps"))) roots.push(path.join(repoRoot, "apps", app));
    roots.push(path.join(packagesDir, "db", "migrations"));
    const naming: string[] = [];
    for (const root of roots) {
      let isDir = false;
      try {
        isDir = statSync(root).isDirectory();
      } catch {
        // fx-swallow-ok: a package without a src folder has nothing to scan
      }
      if (!isDir) continue;
      for (const file of sourceFiles(root)) if (NAMES.test(readFileSync(file, "utf8"))) naming.push(rel(file));
    }
    expect(naming.sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it("no file on a security path names them, and none of them is on the allowed list", () => {
    for (const file of SECURITY_PATHS) {
      expect(ALLOWED[file], `${file} must never be allowed`).toBeUndefined();
      let text: string;
      try {
        text = readFileSync(path.join(repoRoot, file), "utf8");
      } catch {
        // fx-swallow-ok: a listed path that does not exist yet names nothing; the first test still covers every file that does
        continue;
      }
      expect(NAMES.test(text), file).toBe(false);
    }
  });

  it("the claim and hello routes only write: no select of the new tables, and nothing in the claim reads a stored limit", () => {
    for (const file of ["packages/runner-cloud/src/claim.ts", "packages/runner-cloud/src/hello.ts", "packages/runner-cloud/src/heartbeat.ts"]) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      expect(text, file).not.toMatch(/(FROM|JOIN)\s+runner_sandbox/i);
      expect(text, file).not.toMatch(/(FROM|JOIN)\s+runner_facts/i);
    }
  });
});
