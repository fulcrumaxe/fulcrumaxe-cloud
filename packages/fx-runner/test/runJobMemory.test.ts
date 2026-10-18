import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeEngine } from "../src/engines/claude/engine.js";
import { createMemoryLedger, runJob } from "../src/job/runJob.js";
import { createWorkspaceStore } from "../src/job/workspace.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import { RUN_ID, makeFake, makeRig } from "./engines/claude/rig.js";
import { sampleJob } from "./helpers/sampleJob.js";

/**
 * D#601 MEM-3b over the real job runner, the real engine and the host tier (a fake binary stands in for the CLI): the memory a job carries reaches the
 * agent's standard input in the right places, and after the job ends no file under the runner's directories holds any of it.
 */
const PERSON_TEXT = "PLANTED-PERSON-MEMORY-8f3a use pnpm for installs";
const FENCED_TEXT = "PLANTED-FENCED-MEMORY-5c1d <<UNTRUSTED EXTERNAL CONTENT>>\nan agent note\n<<END UNTRUSTED>>";
const NEEDLES = ["PLANTED-PERSON-MEMORY-8f3a", "PLANTED-FENCED-MEMORY-5c1d", "an agent note", "use pnpm for installs"];

/** Every regular file under `dir`, any depth, without following a link. */
function everyFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return everyFile(full);
    return lstatSync(full).isFile() ? [full] : [];
  });
}

async function runWithMemory(memory: { person: string; fenced: string } | undefined) {
  const fake = makeFake();
  const rig = makeRig({ fake });
  const stateDir = path.join(rig.root, "state");
  const host = createHostSandbox({
    credentials: { mode: "subscription" },
    makeRuntime: (sandbox, protectedList) => createClaudeEngine({ ...rig.config, sandboxSettings: sandbox, protectedPaths: protectedList }),
    home: rig.root,
    stateDir,
    binaryDir: path.dirname(fake.binary),
    tempRoot: path.join(rig.root, "tmp"),
    workspaceRoot: path.join(rig.root, "work"),
  });
  const workspaces = createWorkspaceStore(path.join(rig.root, "work"));
  const job = { ...sampleJob({ prompt: "TASK-TEXT-FROM-CLOUD", ...(memory ? { memory } : {}) }), job_id: "22222222-2222-4222-8222-222222222222", run_id: RUN_ID, continues: null, model_hint: null };
  const out = await runJob(job, { sandbox: host, workspaces, ledger: createMemoryLedger(), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" });
  return { out, rig, fake };
}

describe("D#601 MEM-3b: memory through the job runner", () => {
  it("hands the agent the person's lines before the untrusted block and the fenced lines inside it", async () => {
    const { out, fake } = await runWithMemory({ person: PERSON_TEXT, fenced: FENCED_TEXT });
    expect(out.status).toBe("done");
    const stdin = fake.stdin();
    expect(stdin.indexOf(PERSON_TEXT)).toBeLessThan(stdin.indexOf("<untrusted>"));
    expect(stdin.indexOf(FENCED_TEXT)).toBeGreaterThan(stdin.indexOf("<untrusted>"));
    expect(stdin.indexOf(FENCED_TEXT)).toBeLessThan(stdin.indexOf("TASK-TEXT-FROM-CLOUD"));
    expect(stdin.indexOf("TASK-TEXT-FROM-CLOUD")).toBeLessThan(stdin.lastIndexOf("</untrusted>"));
  });

  it("after the job ends no file under the runner's directories holds the memory text (a filesystem walk with a positive control)", async () => {
    const { out, rig, fake } = await runWithMemory({ person: PERSON_TEXT, fenced: FENCED_TEXT });
    expect(out.status).toBe("done");
    // Control: the text did reach the agent, so the needles are the ones that were in play.
    expect(NEEDLES.every((needle) => fake.stdin().includes(needle))).toBe(true);
    const files = everyFile(rig.root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = readFileSync(file);
      for (const needle of NEEDLES) expect(bytes.includes(Buffer.from(needle, "utf8")), `${file} holds ${needle}`).toBe(false);
    }
    // The fake binary's own capture is outside the runner's directories (the walk skipped nothing that holds the text).
    expect(files.some((file) => file.startsWith(fake.dir))).toBe(false);
    expect(readFileSync(path.join(fake.dir, "stdin.txt"), "utf8")).toContain(NEEDLES[0]!);
  });

  it("a job without memory gives the agent the same input as ever", async () => {
    const { fake } = await runWithMemory(undefined);
    expect(fake.stdin()).not.toContain("MEMORY");
  });
});
