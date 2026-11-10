import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEPLOY_VERIFIER_ROLE, type BrowserMethod } from "@fulcrumaxe/runner-protocol";
import { outcomeOf } from "../../src/engines/claude/engine.js";
import { settingsFor, type VerifyServerSpec } from "../../src/engines/claude/settingsFile.js";
import { sessionOfRun, takeoverCommand } from "../../src/engines/claude/takeover.js";
import { buildPrompt } from "../../src/job/prompt.js";
import { protectedPaths } from "../../src/sandbox/sandboxSettings.js";
import { RUN_ID, engineFor, makeRig } from "../engines/claude/rig.js";
import { sampleJob } from "../helpers/sampleJob.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#749 V2c-2b (from the V2c-1 review): EVERY `roleToolsFor` call in the runner takes the job's signed browser method, or a playwright job would launch, resume, take over or be
 * prompted with the Chrome list. `roleToolsFor` is wrapped here so each call site is observed to pass `playwright_runner`; the real function still runs. A mutation drops the method at one site
 * and the test for that site goes red.
 */
const calls: Array<{ role: string; method: unknown }> = [];
vi.mock("../../src/job/roleTools.js", async (original) => {
  const real = await original<typeof import("../../src/job/roleTools.js")>();
  return {
    ...real,
    roleToolsFor: (role: string, method?: BrowserMethod) => {
      calls.push({ role, method });
      return real.roleToolsFor(role, method);
    },
  };
});

const root = mkdtempSync(path.join(tmpRoot(), "pw-sites-"));
const SERVER: VerifyServerSpec = { command: "/opt/fx/fx-runner", args: [], baseUrl: "https://app.example.test/", executable: "/opt/chrome/chromium", storageState: "/h/.config/fx-runner/verify/s.json" };
const seen = (role: string) => calls.filter((c) => c.role === role).map((c) => c.method);
beforeEach(() => void (calls.length = 0));

describe("each roleToolsFor call site passes the job's browser method", () => {
  it("engine.ts: a start and a resume", async () => {
    const rig = makeRig();
    rig.config.verifyServer = () => SERVER;
    const engine = engineFor(rig);
    const first = await engine.start({ ...rig.startOptions({ role: DEPLOY_VERIFIER_ROLE }), browserMethod: "playwright_runner" } as never);
    await outcomeOf(first.handle);
    const started = seen(DEPLOY_VERIFIER_ROLE);
    expect(started.length).toBeGreaterThan(0);
    expect(started.every((m) => m === "playwright_runner")).toBe(true);
    calls.length = 0;
    await outcomeOf((await engine.resume(first.handle, "sess-0001", "next")).handle);
    expect(seen(DEPLOY_VERIFIER_ROLE).length).toBeGreaterThan(0);
    expect(seen(DEPLOY_VERIFIER_ROLE).every((m) => m === "playwright_runner")).toBe(true);
  });

  it("settingsFile.ts: the confined-read branch (the deploy verifier) and the general branch", () => {
    const list = protectedPaths({ home: path.join(root, "home"), stateDir: path.join(root, "home", ".fx-runner"), binaryDir: path.join(root, "bin") });
    settingsFor(DEPLOY_VERIFIER_ROLE, { enabled: true }, path.join(root, "ws"), list, [], undefined, undefined, "playwright_runner");
    expect(seen(DEPLOY_VERIFIER_ROLE)).toEqual(["playwright_runner"]);
    calls.length = 0;
    settingsFor("executor", { enabled: true }, path.join(root, "ws"), list, [], undefined, undefined, "playwright_runner");
    expect(seen("executor")).toEqual(["playwright_runner"]);
  });

  it("takeover.ts: the resumed take-over command", async () => {
    const rig = makeRig();
    rig.config.verifyServer = () => SERVER;
    await outcomeOf((await engineFor(rig).start({ ...rig.startOptions({ role: DEPLOY_VERIFIER_ROLE }), browserMethod: "playwright_runner" } as never)).handle);
    // The session the run recorded and its workspace are what a take-over resumes.
    mkdirSync(rig.workdir, { recursive: true });
    const session = sessionOfRun(path.join(rig.config.logDir, `${RUN_ID}.jsonl`));
    expect(session).toBeDefined();
    writeFileSync(rig.config.sessionsFile, JSON.stringify({ [session!]: { workspace: rig.workdir } }));
    calls.length = 0;
    const take = takeoverCommand({ stateDir: rig.root, runId: RUN_ID, role: DEPLOY_VERIFIER_ROLE, browserMethod: "playwright_runner" });
    expect(take.argv).toContain("--mcp-config");
    expect(seen(DEPLOY_VERIFIER_ROLE)).toEqual(["playwright_runner"]);
    // The person's own "Chrome on by default" setting must not add the extension's tools to a take-over of a playwright job, as in the job's own command line.
    expect(take.argv).toContain("--no-chrome");
    expect(take.argv).not.toContain("--chrome");
    // Control: a take-over of any other method is the command it always was.
    for (const method of [undefined, "chrome_runner"] as const) expect(takeoverCommand({ stateDir: rig.root, runId: RUN_ID, role: DEPLOY_VERIFIER_ROLE, browserMethod: method }).argv, String(method)).not.toContain("--no-chrome");
  });

  it("job/prompt.ts: the prompt of a playwright job", () => {
    const job = { ...sampleJob({ role: DEPLOY_VERIFIER_ROLE }), browser_method: "playwright_runner" as const };
    expect(buildPrompt(job)).toContain("deploy-verifier");
    expect(seen(DEPLOY_VERIFIER_ROLE)).toEqual(["playwright_runner"]);
  });
});
