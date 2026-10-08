import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SpawnFn } from "../../../src/engines/claude/capture.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const DEFAULT_VERSION = "2.1.289";

/** The real `claude --help` of the captured build (2.1.289). */
export const FULL_HELP = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "help.2.1.289.txt"), "utf8");

/** `help` with every standalone mention of `flag` renamed to `renamed`, so the flag is no longer listed under its own name. */
export function helpWithout(help: string, flag: string, renamed: string = `${flag}-gone`): string {
  return help.replace(new RegExp(String.raw`(^|[\s,|])${flag}(?=[\s,<\[=|]|$)`, "gm"), `$1${renamed}`);
}

/** A fixture's lines without its `_fixture` header: what the binary would print. */
export function fixtureText(name: string, withHeader = false): string {
  return readFileSync(path.join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line !== "" && (withHeader || !line.startsWith('{"_fixture"')))
    .join("\n")
    .concat("\n");
}

/** The auth fixture with its header key removed, as JSON text. */
export function authText(name: string): string {
  const { _fixture, ...rest } = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;
  void _fixture;
  return JSON.stringify(rest);
}

export interface Fake {
  dir: string;
  binary: string;
  /** Every invocation's first two arguments, one line each. */
  calls(): string[];
  argv(): string[];
  stdin(): string;
  envText(): string;
  set(file: string, text: string): void;
  spawnCount(): number;
}

/**
 * A shell script standing in for the installed binary. `--version`, `--help` and `auth status` answer from files in `dir`; any other
 * call records its argv, standard input and environment, then prints `stream.jsonl` (and stderr.txt) and exits, or
 * replaces itself with a long sleep when `hang` exists, so a signal ends it.
 */
export function makeFake(opts: { stream?: string; auth?: string; version?: string; help?: string } = {}): Fake {
  const dir = mkdtempSync(path.join(tmpdir(), "r4b12_fake-"));
  const binary = path.join(dir, "bin", "agent");
  mkdirSync(path.dirname(binary));
  const script = `#!/bin/sh
D='${dir}'
echo "$1 $2" >> "$D/calls.txt"
case "$1" in
  --version) echo '${opts.version ?? `${DEFAULT_VERSION} (Claude Code)`}'; exit 0;;
  --help) cat "$D/help.txt"; exit 0;;
  auth) [ -f "$D/auth.sleep" ] && exec sleep 30; cat "$D/auth.json"; [ -f "$D/auth.fail" ] && exit 1; exit 0;;
esac
[ -f "$D/unknown-option" ] && { echo "error: unknown option '--permission-prompts'" >&2; exit 1; }
printf '%s\\n' "$@" > "$D/argv.txt"
env > "$D/env.txt"
cat > "$D/stdin.txt"
cat "$D/stream.jsonl"
[ -f "$D/stderr.txt" ] && cat "$D/stderr.txt" >&2
[ -f "$D/hang" ] && exec sleep 30
exit "$(cat "$D/exit-code" 2>/dev/null || echo 0)"
`;
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  const fake: Fake = {
    dir,
    binary,
    calls: () => (existsSync(path.join(dir, "calls.txt")) ? readFileSync(path.join(dir, "calls.txt"), "utf8").replace(/\n$/, "").split("\n") : []),
    argv: () => readFileSync(path.join(dir, "argv.txt"), "utf8").replace(/\n$/, "").split("\n"),
    stdin: () => readFileSync(path.join(dir, "stdin.txt"), "utf8"),
    envText: () => readFileSync(path.join(dir, "env.txt"), "utf8"),
    set: (file, text) => writeFileSync(path.join(dir, file), text),
    spawnCount: () => fake.calls().length,
  };
  fake.set("stream.jsonl", opts.stream ?? (existsSync(path.join(FIXTURES, "stream.subscription.jsonl")) ? fixtureText("stream.subscription.jsonl") : ""));
  fake.set("help.txt", opts.help ?? FULL_HELP);
  fake.set("auth.json", opts.auth ?? authText("auth.claude_ai.json"));
  return fake;
}

/** A spawn that records each command it is asked to run, then runs it. */
export function countingSpawn(): { spawn: SpawnFn; spawns: string[] } {
  const spawns: string[] = [];
  const counting = ((command: string, ...rest: unknown[]) => {
    spawns.push(command);
    return (spawn as unknown as (...args: unknown[]) => ReturnType<typeof spawn>)(command, ...rest);
  }) as SpawnFn;
  return { spawn: counting, spawns };
}

/** A temporary root with an empty workspace directory inside it. */
export function makeWorkspace(): { root: string; workdir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "r4b12_ws-"));
  const workdir = path.join(root, "workspace");
  mkdirSync(workdir);
  return { root, workdir };
}
