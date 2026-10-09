#!/usr/bin/env node
// The one place the command line meets the shell: it looks up a few variables by name and hands everything to runCli.
// The environment is never copied, listed or passed on (test/cli/cli.test.ts checks this file). It is also where the real process
// start, the real signal source and this program's own path are handed to `run`, `doctor` and `service`, so that nothing under
// src/ has to name them. The two Anthropic variables reach `doctor` as names only, never as values.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { createClaudeKit } from "../src/engines/claude/kit.js";
import { createSandboxHost } from "../src/sandbox/probeHost.js";

const engine = createClaudeKit(spawn);
const shellVars = [];
if (process.env.ANTHROPIC_API_KEY) shellVars.push("ANTHROPIC_API_KEY");
if (process.env.ANTHROPIC_AUTH_TOKEN) shellVars.push("ANTHROPIC_AUTH_TOKEN");

const code = await runCli({
  argv: process.argv.slice(2),
  home: process.env.HOME,
  stateDirOverride: process.env.FX_RUNNER_HOME,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  host: {
    home: process.env.HOME,
    platform: process.platform,
    xdgCacheHome: process.env.XDG_CACHE_HOME,
    signals: process,
    pid: process.pid,
    kill: (pid, signal) => process.kill(pid, signal),
    engine,
  },
  doctorHost: { platform: process.platform, shellVars, engine, home: process.env.HOME, xdgCacheHome: process.env.XDG_CACHE_HOME, sandbox: createSandboxHost(engine.captureWithStderr) },
  serviceHost: {
    home: process.env.HOME,
    platform: process.platform,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    command: [process.execPath, realpathSync(fileURLToPath(import.meta.url)), "run"],
    path: process.env.PATH,
  },
});
process.exitCode = code;
