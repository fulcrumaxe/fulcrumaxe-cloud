import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DeployOrderReportMessage } from "@fulcrumaxe/runner-protocol";
import { createDeployOrderHandler, checkDeployScript, outputTailOf, runDeployOrder, type DeployOrderDeps, type DeployOutcome } from "../../src/daemon/deployOrder.js";
import type { InstallCapture } from "../../src/daemon/engineKit.js";
import { runInstall } from "../../src/engines/claude/capture.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#749 V2b: the runner's deploy order executor, on real files and real processes. The checkout is a real directory, the capture is the engine's own process-group capture
 * (`runInstall`) over a real `spawn`, and every refusal asserts that nothing outside the checkout changed and that the script behind the refusal did not run.
 */
const SHA = "a1".repeat(20);
const ORDER = { repo: { owner: "acme", name: "widgets" }, sha: SHA };
const UID = process.getuid?.() ?? 0;

let root: string;
let repo: string;
let outside: string;
let env: Record<string, string | undefined>;

const capture: InstallCapture = (command, args, runEnv, cwd, timeoutMs, tailChars, signal, feed, onLine) => runInstall(spawn, command, args, runEnv, cwd, timeoutMs, tailChars, signal, feed, onLine);

function deps(argv: readonly string[] | undefined, over: Partial<DeployOrderDeps> = {}, dir: string | null = repo): DeployOrderDeps {
  return { capture, uid: UID, env, settings: () => ({ verify: { ...(argv === undefined ? {} : { deployArgv: argv }), ...(dir === null ? {} : { deployDir: dir }) } }), ...over };
}

/** Every file below `dir` with its size, mode and content: a change anywhere shows as a difference. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push(`${path.relative(dir, full)}|${stat.mode}|${stat.isSymbolicLink() ? "link" : stat.isFile() ? readFileSync(full, "utf8") : "other"}`);
      if (stat.isDirectory()) out.push(`${path.relative(dir, full)}/|${stat.mode}`);
    }
  };
  walk(dir);
  return out;
}

function write(file: string, text: string, mode = 0o755): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpRoot(), "deploy-order-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  // A fresh pair of folders for every test: the checkout (what the command may touch) and a decoy beside it (what it must never touch).
  const base = mkdtempSync(path.join(root, "case-"));
  repo = path.join(base, "repo");
  outside = path.join(base, "outside");
  mkdirSync(repo, { mode: 0o755 });
  mkdirSync(outside, { mode: 0o755 });
  writeFileSync(path.join(outside, "decoy.txt"), "decoy\n");
  env = { PATH: process.env["PATH"], HOME: base, USER: "tester", ANTHROPIC_API_KEY: "sk-ant-not-for-the-script", SECRET_TOKEN: "hunter2", FX_DEPLOY_SHA: "from-the-daemon-env", LANG: "C" };
});

/** The refusals share one assertion: the report says `script_refused`, the script's marker was never made, and nothing beside the checkout changed. */
async function refusedWith(argv: readonly string[], marker: string, extra: Partial<DeployOrderDeps> = {}, dir: string | undefined = repo): Promise<void> {
  const before = snapshot(path.dirname(repo));
  const outcome = await runDeployOrder(deps(argv, extra, dir), ORDER);
  expect(outcome).toEqual({ result: "failed", failure_code: "script_refused" });
  expect(existsSync(marker)).toBe(false);
  expect(snapshot(path.dirname(repo))).toEqual(before);
}

describe("a deploy order runs the owner's own command", () => {
  it("runs `program script` in the checkout with the commit and repository in the environment, and only an allowlist of the daemon's environment", async () => {
    write(path.join(repo, "deploy.sh"), '#!/bin/sh\necho "deploying $FX_DEPLOY_SHA of $FX_DEPLOY_REPO in $(pwd)"\nenv > "$PWD/seen.env"\n');
    const outcome = await runDeployOrder(deps(["sh", "deploy.sh"]), ORDER);
    expect(outcome).toEqual({ result: "succeeded", exit_code: 0, output_tail: [`deploying ${SHA} of acme/widgets in ${repo}`] });
    const seen = new Map(readFileSync(path.join(repo, "seen.env"), "utf8").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
    // The order's values replace anything of the same name in the daemon's environment; secrets of the daemon never reach the command.
    expect(seen.get("FX_DEPLOY_SHA")).toBe(SHA);
    expect(seen.get("FX_DEPLOY_REPO")).toBe("acme/widgets");
    expect(seen.has("ANTHROPIC_API_KEY")).toBe(false);
    expect(seen.has("SECRET_TOKEN")).toBe(false);
    expect([...seen.keys()].filter((key) => !["PATH", "HOME", "USER", "LANG", "FX_DEPLOY_SHA", "FX_DEPLOY_REPO", "PWD", "SHLVL", "_", "OLDPWD"].includes(key))).toEqual([]);
  });

  it("a script given as the first word (a relative path with a leading ./) runs by its checked absolute path", async () => {
    write(path.join(repo, "bin", "ship.sh"), '#!/bin/sh\necho "ship $1"\n');
    expect(await runDeployOrder(deps(["./bin/ship.sh", "staging"]), ORDER)).toEqual({ result: "succeeded", exit_code: 0, output_tail: ["ship staging"] });
  });

  it("an argument is data: shell syntax in it is not interpreted", async () => {
    const marker = path.join(repo, "pwned");
    write(path.join(repo, "deploy.sh"), '#!/bin/sh\necho "arg=$1"\n');
    const outcome = await runDeployOrder(deps(["sh", "deploy.sh", `; touch ${marker}`]), ORDER);
    expect(outcome).toMatchObject({ result: "succeeded", output_tail: [`arg=; touch ${marker}`] });
    expect(existsSync(marker)).toBe(false);
  });

  it("a non-zero exit is exit_nonzero with the status and the output so far", async () => {
    write(path.join(repo, "deploy.sh"), "#!/bin/sh\necho building\necho 'boom: it broke' >&2\nexit 3\n");
    expect(await runDeployOrder(deps(["sh", "deploy.sh"]), ORDER)).toEqual({ result: "failed", failure_code: "exit_nonzero", exit_code: 3, output_tail: ["building", "boom: it broke"] });
  });

  it("a command that cannot start, or that a signal ended, is spawn_failed with no exit status", async () => {
    write(path.join(repo, "deploy.sh"), "#!/bin/sh\nkill -9 $$\n");
    expect(await runDeployOrder(deps(["no-such-program-d749", "deploy.sh"]), ORDER)).toEqual({ result: "failed", failure_code: "spawn_failed" });
    expect(await runDeployOrder(deps(["sh", "deploy.sh"]), ORDER)).toEqual({ result: "failed", failure_code: "spawn_failed" });
  });

  it("every outcome it can give is a report the protocol accepts", async () => {
    write(path.join(repo, "ok.sh"), "#!/bin/sh\necho ok\n");
    write(path.join(repo, "bad.sh"), "#!/bin/sh\nexit 9\n");
    const outcomes: Array<DeployOutcome | "aborted"> = [
      await runDeployOrder(deps(["sh", "ok.sh"]), ORDER),
      await runDeployOrder(deps(["sh", "bad.sh"]), ORDER),
      await runDeployOrder(deps(["sh", "missing.sh"]), ORDER),
      await runDeployOrder(deps(undefined), ORDER),
      await runDeployOrder(deps(["sh", "ok.sh"], { timeoutMs: 1 }, repo), { ...ORDER }),
    ];
    for (const outcome of outcomes) {
      if (outcome === "aborted") continue;
      const parsed = DeployOrderReportMessage.safeParse({ order_id: "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", lease_generation: 1, ...outcome });
      expect(parsed.success, JSON.stringify(outcome)).toBe(true);
    }
  });
});

describe("it is not configured until the owner configures it", () => {
  it("no command, or no checkout, is not_configured and nothing runs", async () => {
    const marker = path.join(repo, "ran");
    write(path.join(repo, "deploy.sh"), `#!/bin/sh\ntouch ${marker}\n`);
    expect(await runDeployOrder(deps(undefined), ORDER)).toEqual({ result: "failed", failure_code: "not_configured" });
    expect(await runDeployOrder(deps(["sh", "deploy.sh"], {}, null), ORDER)).toEqual({ result: "failed", failure_code: "not_configured" });
    expect(await runDeployOrder({ ...deps(["sh", "deploy.sh"]), settings: () => ({}) }, ORDER)).toEqual({ result: "failed", failure_code: "not_configured" });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("the script is checked with lstat before anything runs", () => {
  it("refuses a script that is a symlink, though its target would run", async () => {
    const marker = path.join(outside, "marker");
    write(path.join(outside, "evil.sh"), `#!/bin/sh\ntouch ${marker}\n`);
    symlinkSync(path.join(outside, "evil.sh"), path.join(repo, "deploy.sh"));
    await refusedWith(["sh", "deploy.sh"], marker);
  });

  it("refuses a script behind a symlinked folder, and a checkout that is itself a symlink", async () => {
    const marker = path.join(outside, "marker");
    write(path.join(outside, "scripts", "deploy.sh"), `#!/bin/sh\ntouch ${marker}\n`);
    symlinkSync(path.join(outside, "scripts"), path.join(repo, "scripts"));
    await refusedWith(["sh", "scripts/deploy.sh"], marker);
    const real = path.join(path.dirname(repo), "real");
    mkdirSync(real, { mode: 0o755 });
    write(path.join(real, "deploy.sh"), `#!/bin/sh\ntouch ${marker}\n`);
    const link = path.join(path.dirname(repo), "link");
    symlinkSync(real, link);
    await refusedWith(["sh", "deploy.sh"], marker, {}, link);
  });

  it("refuses a path that leaves the checkout: .., an absolute path, a doubled or empty part", async () => {
    const marker = path.join(outside, "marker");
    write(path.join(outside, "evil.sh"), `#!/bin/sh\ntouch ${marker}\n`);
    write(path.join(repo, "a", "keep"), "x\n");
    for (const word of ["../outside/evil.sh", "a/../../outside/evil.sh", path.join(outside, "evil.sh"), "a//keep", "a/./keep", "./", "", ".", ".."]) {
      await refusedWith(["sh", word], marker);
    }
    await refusedWith([path.join(outside, "evil.sh")], marker);
    await refusedWith(["../outside/evil.sh"], marker);
    await refusedWith(["sh", "back\\slash"], marker);
  });

  it("refuses a folder, a named pipe, a script others can write, a script of another user, and a checkout others can write", async () => {
    const marker = path.join(repo, "marker");
    mkdirSync(path.join(repo, "dir.sh"));
    await refusedWith(["sh", "dir.sh"], marker);
    execFileSync("mkfifo", [path.join(repo, "pipe.sh")]);
    await refusedWith(["sh", "pipe.sh"], marker);
    write(path.join(repo, "open.sh"), `#!/bin/sh\ntouch ${marker}\n`, 0o777);
    await refusedWith(["sh", "open.sh"], marker);
    write(path.join(repo, "deploy.sh"), `#!/bin/sh\ntouch ${marker}\n`);
    await refusedWith(["sh", "deploy.sh"], marker, { uid: UID + 1 });
    chmodSync(repo, 0o777);
    await refusedWith(["sh", "deploy.sh"], marker);
    chmodSync(repo, 0o755);
  });

  it("refuses a script that is not there, a flag where the script belongs (so `sh -c` can never be asked for), and a checkout path that is not plain", async () => {
    const marker = path.join(repo, "marker");
    write(path.join(repo, "deploy.sh"), `#!/bin/sh\ntouch ${marker}\n`);
    await refusedWith(["sh", "missing.sh"], marker);
    await refusedWith(["sh"], marker);
    await refusedWith(["sh", "-c", `touch ${marker}`], marker);
    await refusedWith(["-x", "deploy.sh"], marker);
    await refusedWith(["sh", "deploy.sh"], marker, {}, "relative/path");
    await refusedWith(["sh", "deploy.sh"], marker, {}, `${repo}/../repo`);
    await refusedWith(["sh", "deploy.sh"], marker, {}, `${repo}/`);
  });

  it("checkDeployScript names the absolute script it checked, and which argument it was", () => {
    write(path.join(repo, "s", "deploy.sh"), "#!/bin/sh\n");
    expect(checkDeployScript(repo, ["sh", "s/deploy.sh", "x"], UID)).toEqual({ ok: true, script: path.join(repo, "s", "deploy.sh"), scriptIndex: 1 });
    expect(checkDeployScript(repo, ["./s/deploy.sh"], UID)).toEqual({ ok: true, script: path.join(repo, "s", "deploy.sh"), scriptIndex: 0 });
    expect(checkDeployScript(repo, [], UID)).toEqual({ ok: false });
  });

  it("refuses an order whose commit or repository name is not the shape of one, before anything runs", async () => {
    const marker = path.join(repo, "marker");
    write(path.join(repo, "deploy.sh"), `#!/bin/sh\ntouch ${marker}\n`);
    for (const order of [{ ...ORDER, sha: "main" }, { ...ORDER, sha: `${SHA}; touch x` }, { ...ORDER, sha: SHA.toUpperCase() }, { repo: { owner: "a/b", name: "w" }, sha: SHA }, { repo: { owner: "acme", name: "w w" }, sha: SHA }, { repo: { owner: "acme", name: "../x" }, sha: SHA }]) {
      expect(await runDeployOrder(deps(["sh", "deploy.sh"]), order)).toEqual({ result: "failed", failure_code: "script_refused" });
    }
    expect(existsSync(marker)).toBe(false);
  });
});

describe("a command that runs too long is ended with everything it started", () => {
  it("the time limit kills the whole process group: a child the script left running never finishes its work", async () => {
    const late = path.join(repo, "late-marker");
    write(path.join(repo, "deploy.sh"), `#!/bin/sh\n( sleep 1.2; touch ${late} ) &\necho started\nsleep 30\n`);
    const outcome = await runDeployOrder(deps(["sh", "deploy.sh"], { timeoutMs: 400 }), ORDER);
    expect(outcome).toEqual({ result: "failed", failure_code: "timeout", output_tail: ["started"] });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(existsSync(late)).toBe(false);
  });

  it("a stop of the daemon ends the group and reports nothing", async () => {
    const late = path.join(repo, "late-marker");
    write(path.join(repo, "deploy.sh"), `#!/bin/sh\n( sleep 1.2; touch ${late} ) &\nsleep 30\n`);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    expect(await runDeployOrder(deps(["sh", "deploy.sh"], { signal: stop.signal }), ORDER)).toBe("aborted");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(existsSync(late)).toBe(false);
  });
});

describe("what goes back is the last 20 lines, scrubbed", () => {
  it("keeps only the last 20 lines, each cut to 200 characters, with control characters removed", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    expect(outputTailOf(lines.join("\n"))).toEqual(lines.slice(-20));
    expect(outputTailOf(`${"x".repeat(500)}\n`)).toEqual(["x".repeat(200)]);
    expect(outputTailOf("a\u001b[31mred\u001b[0m\tb\r\nc\u0000d‮e\n\n\n")).toEqual(["a[31mred[0m b", "cde"]);
  });

  it("redacts secret shapes, and never leaves half of a character at a cut", () => {
    const token = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
    const [line] = outputTailOf(`using token ${token} now`);
    expect(line).not.toContain(token);
    const cut = outputTailOf(`${"y".repeat(199)}\u{1F600}`)[0]!;
    expect(cut).toBe(`${"y".repeat(199)}�`);
    expect(new TextDecoder().decode(new TextEncoder().encode(cut))).toBe(cut);
  });

  it("a real run's output goes through it: a token the script prints is not in the report", async () => {
    const token = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
    write(path.join(repo, "deploy.sh"), `#!/bin/sh\necho "token ${token}"\n`);
    const outcome = await runDeployOrder(deps(["sh", "deploy.sh"]), ORDER);
    expect(JSON.stringify(outcome)).not.toContain(token);
    expect(outcome).toMatchObject({ result: "succeeded" });
  });
});

describe("the handler: claim, run, report", () => {
  const order = { order_id: "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", lease_generation: 2, lease_expires_at: "2026-11-09T12:00:00.000Z", repo: ORDER.repo, sha: SHA };

  function rig(claim: unknown, outcome: DeployOutcome | "aborted", reports: unknown[] = [{ kind: "recorded" }]) {
    const sent: unknown[] = [];
    const ran: unknown[] = [];
    const replies = [...reports];
    const handler = createDeployOrderHandler({
      client: {
        deployOrderClaim: async () => claim as never,
        deployOrderReport: async (message) => (sent.push(message), (replies.shift() ?? { kind: "recorded" }) as never),
      },
      run: async (o) => (ran.push(o), outcome),
    });
    return { handler, sent, ran };
  }

  it("claims, runs with only the repository and the commit, and reports under the order and lease it was given", async () => {
    const r = rig({ kind: "order", order }, { result: "succeeded", exit_code: 0, output_tail: ["done"] });
    expect(await r.handler()).toBe("handled");
    expect(r.ran).toEqual([{ repo: ORDER.repo, sha: SHA }]);
    expect(r.sent).toEqual([{ order_id: order.order_id, lease_generation: 2, result: "succeeded", exit_code: 0, output_tail: ["done"] }]);
  });

  it("nothing to do is none and runs nothing; a fenced claim is none", async () => {
    for (const claim of [{ kind: "none", retryAfter: 60 }, { kind: "fenced" }, { kind: "error", status: 500 }]) {
      const r = rig(claim, { result: "succeeded", exit_code: 0 });
      expect(await r.handler()).toBe("none");
      expect(r.ran).toEqual([]);
      expect(r.sent).toEqual([]);
    }
  });

  it("a report that did not get through is sent once more; a fenced report is not; a stop of the daemon reports nothing", async () => {
    const lost = rig({ kind: "order", order }, { result: "failed", failure_code: "timeout" }, [{ kind: "error", status: 0 }, { kind: "recorded" }]);
    await lost.handler();
    expect(lost.sent).toHaveLength(2);
    const fenced = rig({ kind: "order", order }, { result: "failed", failure_code: "timeout" }, [{ kind: "fenced" }]);
    await fenced.handler();
    expect(fenced.sent).toHaveLength(1);
    const never = rig({ kind: "order", order }, "aborted");
    expect(await never.handler()).toBe("handled");
    expect(never.sent).toEqual([]);
  });
});
