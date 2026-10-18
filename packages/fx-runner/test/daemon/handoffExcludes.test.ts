import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { excludeDenyRules } from "@fulcrumaxe/runner-protocol";
import { runCheckpointTurn } from "../../src/daemon/checkpointTurn.js";
import { withExcludes } from "../../src/daemon/jobHandler.js";
import { createClaudeEngine } from "../../src/engines/claude/engine.js";
import { takeoverCommand } from "../../src/engines/claude/takeover.js";
import { sha256Text } from "@fulcrumaxe/runner-protocol";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import { createHostSandbox } from "../../src/sandbox/hostSandbox.js";
import type { SandboxPort } from "../../src/sandbox/port.js";
import { RUN_ID, makeFake, makeRig } from "../engines/claude/rig.js";

/**
 * D#600 CX-5c, handoff: the checkpoint turn resumes the session with options it builds itself. The settings file the real engine writes before that command must still
 * hold the job's deny entries (it used to be rewritten with the protected-path floor only), and so must the file a later take-over reuses. The real host tier and the
 * real engine run over a fake binary; the control run shows what the unwrapped port does.
 */
const EXCLUDES = ["secret/a.txt", "keys", "src/**/[ab].ts"];
const WANTED = excludeDenyRules(EXCLUDES);

async function checkpointOver(wrap: (port: SandboxPort) => SandboxPort) {
  const fake = makeFake();
  const rig = makeRig({ fake });
  const host = createHostSandbox({
    credentials: { mode: "subscription" },
    makeRuntime: (sandbox, protectedList) => createClaudeEngine({ ...rig.config, sandboxSettings: sandbox, protectedPaths: protectedList }),
    home: rig.root,
    stateDir: path.join(rig.root, "state"),
    binaryDir: path.dirname(fake.binary),
    tempRoot: path.join(rig.root, "tmp"),
    workspaceRoot: path.join(rig.root, "work"),
  });
  const workspace = await createWorkspaceStore(path.join(rig.root, "work")).create(RUN_ID);
  const card = "You are the executor.\n";
  const turn = await runCheckpointTurn({
    job: { run_id: RUN_ID, role: "executor", role_card: { text: card, sha256: sha256Text(card) }, model_hint: null },
    sandbox: wrap(host),
    credentials: { mode: "subscription" },
    defaultModel: "sonnet",
    workspace,
    sessionId: "sess-0001",
    signal: new AbortController().signal,
    limitMs: 20_000,
  });
  const settingsPath = path.join(rig.config.jobsDir, RUN_ID, "settings.json");
  return { turn, rig, settings: (): { permissions: { deny: string[] } } => JSON.parse(readFileSync(settingsPath, "utf8")), settingsPath };
}

describe("D#600 CX-5c: the handoff keeps the job's excludes", () => {
  it("after the checkpoint turn the settings file still holds the Read, Grep and Glob deny entries, and the take-over command points at that file", async () => {
    const { turn, rig, settings, settingsPath } = await checkpointOver((port) => withExcludes(port, EXCLUDES));
    expect(turn.finished).toBe(true);
    const deny = settings().permissions.deny;
    expect(deny.slice(-WANTED.length)).toEqual(WANTED);
    expect(deny).toEqual(expect.arrayContaining(["Grep", "Glob"]));
    // The take-over reuses this very file (no rewrite of its own), so it carries the same entries.
    const take = takeoverCommand({ stateDir: rig.root, runId: RUN_ID, role: "executor" });
    expect(take.argv[take.argv.indexOf("--settings") + 1]).toBe(settingsPath);
    expect(JSON.parse(readFileSync(take.argv[take.argv.indexOf("--settings") + 1]!, "utf8")).permissions.deny.slice(-WANTED.length)).toEqual(WANTED);
  });

  it("control: the same turn through the unwrapped port rewrites the file with the floor only (what the wrapper prevents)", async () => {
    const { turn, settings } = await checkpointOver((port) => port);
    expect(turn.finished).toBe(true);
    expect(settings().permissions.deny).not.toContain("Grep");
    expect(settings().permissions.deny.some((rule) => rule.includes("secret/a.txt"))).toBe(false);
  });

  it("a job without excludes gets the very same port back", () => {
    const port = {} as SandboxPort;
    expect(withExcludes(port, undefined)).toBe(port);
    expect(withExcludes(port, [])).toBe(port);
  });
});
