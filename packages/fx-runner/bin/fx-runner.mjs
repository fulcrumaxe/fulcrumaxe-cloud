#!/usr/bin/env node
// The one place the command line meets the shell: it looks up two variables by name and hands everything to runCli.
// The environment is never copied, listed or passed on (src/ may not name `process` at all; test/cli/cli.test.ts checks this file).
import { runCli } from "../src/cli.js";

const code = await runCli({
  argv: process.argv.slice(2),
  home: process.env.HOME,
  stateDirOverride: process.env.FX_RUNNER_HOME,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exitCode = code;
