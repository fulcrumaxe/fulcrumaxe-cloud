import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));
const text = (name: string) => readFileSync(path.join(srcDir, name), "utf8");

/**
 * D#605 FL-4: what a runner reported about itself, and the rules a person set, are read in one place and used for one thing, choosing among runs the existing
 * filters already allow. Nothing that authorizes a request or signs a job may reach them.
 */
describe("routing facts and rules stay out of authorization (import graph)", () => {
  it("only the routing module names the facts table, the rules columns or the poll stamps", () => {
    for (const name of files) {
      const body = text(name);
      if (name === "runnerRouting.ts") continue;
      expect(body, name).not.toMatch(/runner_facts|runner_routing|runner_claim_stamps/);
    }
  });

  it("only the claim imports the routing module, and the job signer and the git ticket signer reach neither it nor the claim", () => {
    const importers = files.filter((name) => /from "\.\/runnerRouting\.js"/.test(text(name)));
    expect(importers).toEqual(["runnerClaims.ts"]);
    const importsOf = (name: string): string[] => [...text(name).matchAll(/from\s+"\.\/([^"]+)\.js"/g)].map((m) => `${m[1]}.ts`).filter((n) => files.includes(n));
    const closure = (entry: string): Set<string> => {
      const seen = new Set<string>();
      const walk = (name: string): void => {
        if (seen.has(name)) return;
        seen.add(name);
        for (const next of importsOf(name)) walk(next);
      };
      walk(entry);
      return seen;
    };
    // (runnerGitTicket.ts takes the lease fence helpers from runnerClaims.ts, so it reaches the module statically; it calls nothing in it.)
    for (const entry of ["jobSigner.ts", "gitTicketSigner.ts"]) {
      const reached = closure(entry);
      expect(reached.has("runnerRouting.ts"), `${entry} reaches the routing module`).toBe(false);
      expect(reached.has("runnerClaims.ts"), `${entry} reaches the claim`).toBe(false);
    }
  });
});
