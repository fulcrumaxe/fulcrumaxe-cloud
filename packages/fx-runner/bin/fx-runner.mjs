#!/usr/bin/env node
// The one place the command line meets the shell: it looks up a few variables by name and hands everything to runCli.
// The environment is never copied, listed or passed on (test/cli/cli.test.ts checks this file). It is also where the real process
// start, the real signal source and this program's own path are handed to `run`, `doctor` and `service`, so that nothing under
// src/ has to name them. The two Anthropic variables reach `doctor` as names only, never as values.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { RUNNER_VERSION } from "../src/version.js";
import { API_KEY_MAX_BYTES } from "../src/credentials.js";
import { readSecret } from "../src/secretInput.js";
import { createClaudeKit } from "../src/engines/claude/kit.js";
import { createSandboxHost } from "../src/sandbox/probeHost.js";
import { vmBuildHost } from "../scripts/vm-host.mjs";

const engine = createClaudeKit(spawn);
const shellVars = [];
if (process.env.ANTHROPIC_API_KEY) shellVars.push("ANTHROPIC_API_KEY");
if (process.env.ANTHROPIC_AUTH_TOKEN) shellVars.push("ANTHROPIC_AUTH_TOKEN");

// What self-update needs (D#6 R6-2b): the version, where this program really is, whether a service manager started it (the unit sets
// FX_RUNNER_SERVICE=1), and a way to run a freshly installed program for its start check, in a clean environment and on a time limit.
const execPath = realpathSync(process.execPath);
const updateHost = {
  version: RUNNER_VERSION,
  platform: process.platform,
  arch: process.arch,
  execPath,
  inService: process.env.FX_RUNNER_SERVICE === "1",
  run: (file, args, timeoutMs) =>
    new Promise((resolve) => {
      let stdout = "";
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, FX_RUNNER_HOME: process.env.FX_RUNNER_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
      try {
        const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs, killSignal: "SIGKILL" });
        child.stdout.on("data", (chunk) => {
          if (stdout.length < 65536) stdout += chunk.toString("utf8");
        });
        child.on("error", () => resolve({ code: null, stdout: "" }));
        child.on("close", (exit) => resolve({ code: exit, stdout }));
      } catch {
        resolve({ code: null, stdout: "" });
      }
    }),
};

// Run from the single-executable release build (scripts/build-sea.mjs), the program is process.execPath itself and there is no script file to name:
// the bundle is CommonJS (no top-level await, no import.meta), so this file is one promise chain and the script path is only looked up when it exists.
const sea = isSea();
const scriptPath = () => realpathSync(fileURLToPath(import.meta.url));

runCli({
  updateHost,
  argv: process.argv.slice(2),
  home: process.env.HOME,
  stateDirOverride: process.env.FX_RUNNER_HOME,
  // A file holding the Vercel protection bypass secret, for a staging or protected-preview cloud. Only the path is read here; src/protectionBypass.ts reads the file.
  protectionBypassFile: process.env.FX_RUNNER_PROTECTION_BYPASS_FILE,
  uid: process.getuid?.(),
  platform: process.platform,
  xdgCacheHome: process.env.XDG_CACHE_HOME,
  // The one place standard input is touched: the API key is read here, never taken from the command line.
  readSecret: () => readSecret(process.stdin, (text) => process.stderr.write(text), API_KEY_MAX_BYTES),
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
    sandbox: createSandboxHost(engine.captureWithStderr),
    // How a tmux pane starts this program again (the watch and take-over panes), the terminal type, and the one question take-over asks.
    selfCommand: sea ? [process.execPath] : [process.execPath].concat(process.execArgv, [scriptPath()]),
    term: process.env.TERM,
    uid: process.getuid?.(),
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
    // The take-over confirmation must be typed by a person: a piped stdin is not one.
    interactive: process.stdin.isTTY === true,
    ask: async (question) => {
      const lines = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await lines.question(question);
      } finally {
        lines.close();
      }
    },
  },
  doctorHost: { platform: process.platform, shellVars, engine, home: process.env.HOME, shell: process.env.SHELL, xdgCacheHome: process.env.XDG_CACHE_HOME, uid: process.getuid?.(), xdgRuntimeDir: process.env.XDG_RUNTIME_DIR, sandbox: createSandboxHost(engine.captureWithStderr), update: { version: RUNNER_VERSION, execPath } },
  vmHost: vmBuildHost,
  serviceHost: {
    home: process.env.HOME,
    platform: process.platform,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    command: sea ? [process.execPath, "run"] : [process.execPath, scriptPath(), "run"],
    path: process.env.PATH,
    execPath,
  },
}).then((code) => {
  process.exitCode = code;
});
