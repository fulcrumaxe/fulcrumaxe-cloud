#!/usr/bin/env node
// The one place the command line meets the shell: it looks up three variables by name and hands everything to runCli.
// The environment is never copied, listed or passed on (test/cli/cli.test.ts checks this file). It is also where the real process
// start and the real signal source are handed to `run`, so that nothing under src/ has to name them.
import { spawn } from "node:child_process";
import { runCli } from "../src/cli.js";
import { createClaudeKit } from "../src/engines/claude/kit.js";

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
    engine: createClaudeKit(spawn),
  },
});
process.exitCode = code;
