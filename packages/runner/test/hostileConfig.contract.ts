import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D#2 H14c-SS (C59) SS-CONTRACT: the conformance test for "the agent loads
 * configuration only from files the runner writes". EVERY new backend
 * (D#221 R2/R3) registers with `runHostileConfigContract` in its own PR, and a
 * backend without a registration is not selectable.
 * A backend's registration plants the fixture at the workspace path its runner
 * actually hands the agent (the checkout root), never a directory its runner
 * doesn't read.
 */
export const HOSTILE_REPO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hostile-repo");

/** What one backend's runner did for one start plus one resume. */
export interface ProducedRun {
  /** The workspace root the agent ran in. */
  workdir: string;
  /** Every agent command's argv (start first, then resume). */
  argv: string[][];
  /** Every env passed to a command. */
  envs: Record<string, string>[];
  /** Every file the runner wrote, in order. */
  writes: { path: string; content: string; mode?: number }[];
}

export interface HostileConfigBackend {
  name: string;
  /** Each group must appear, contiguous and in order, in every agent argv. */
  requiredArgv: readonly (readonly string[])[];
}

export type Produce = (workspaceFiles: Readonly<Record<string, string>>) => Promise<ProducedRun>;

/** Every file under `dir`, keyed by its `/`-separated relative path. */
export function readTree(dir: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(path.join(dir, rel)).sort()) {
    const r = rel === "" ? name : `${rel}/${name}`;
    if (statSync(path.join(dir, r)).isDirectory()) Object.assign(out, readTree(dir, r));
    else out[r] = readFileSync(path.join(dir, r), "utf8");
  }
  return out;
}

export const sentinelsOf = (files: Readonly<Record<string, string>>): string[] =>
  [...new Set(Object.values(files).flatMap((c) => c.match(/FXSENT-[A-Za-z0-9-]+/g) ?? []))].sort();

const hasGroup = (argv: readonly string[], group: readonly string[]): boolean =>
  argv.some((_, i) => group.every((g, j) => argv[i + j] === g));

/** The contract's violations for one backend (empty when it conforms). */
export async function hostileConfigViolations(backend: HostileConfigBackend, produce: Produce): Promise<string[]> {
  const hostile = readTree(HOSTILE_REPO_DIR);
  const [withHostile, clean] = [await produce(hostile), await produce({})];
  const bad: string[] = [];
  if (JSON.stringify(withHostile) !== JSON.stringify(clean)) bad.push("differential: the workspace changed the runner's output");
  const strings = [
    ...withHostile.argv.flat(),
    ...withHostile.envs.flatMap((e) => Object.values(e)),
    ...withHostile.writes.flatMap((w) => [w.path, w.content]),
  ];
  for (const needle of [...Object.keys(hostile), ...sentinelsOf(hostile)]) {
    if (strings.some((s) => s.includes(needle))) bad.push(`leak: "${needle}" reached argv, env or a written file`);
  }
  const root = withHostile.workdir.replace(/\/+$/, "");
  for (const w of withHostile.writes) {
    if (w.path === root || w.path.startsWith(`${root}/`)) bad.push(`write inside the workspace: ${w.path}`);
  }
  if (withHostile.argv.length < 2) bad.push("produce must record one start and one resume command");
  for (const argv of withHostile.argv) {
    for (const group of backend.requiredArgv) if (!hasGroup(argv, group)) bad.push(`argv lacks ${group.join(" ")}`);
  }
  return bad;
}

/** The backends that have run the contract in this file's test run (D#221 R1a: a backend not in here is not selectable). */
const registeredWithContract = new Set<string>();
export const backendsRegisteredWithContract = (): string[] => [...registeredWithContract].sort();

export function runHostileConfigContract(backend: HostileConfigBackend, produce: Produce): void {
  registeredWithContract.add(backend.name);
  describe(`hostile-config contract: ${backend.name}`, () => {
    it("loads nothing from the workspace", async () => {
      expect(await hostileConfigViolations(backend, produce)).toEqual([]);
    });
  });
}
