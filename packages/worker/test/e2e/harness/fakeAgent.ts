import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_VERSION, FULL_HELP, authText, fixtureText } from "../../../../fx-runner/test/engines/claude/harness.js";

/**
 * D#6 R4d-6: the agent CLI of the end-to-end runner test, a shell script found by the runner through its installed-binary path, standing in for `claude`. It
 * answers `--version`, `--help` and `auth status` the way the captured build does (so the engine's version, flag and login checks run for real), and for a real run
 * it
 *  1. reads the prompt from standard input, as the engine passes it;
 *  2. runs the phase's `act.sh` in its working directory (the run's workspace), which is what the "model" decides to do there;
 *  3. prints a stream of the captured build's shape whose final `result` line carries the phase's `AGENT_OUTPUT` envelope.
 * It makes no model call and reads no credential. A phase's `act.sh` can refuse the prompt it was given (exit non-zero before any output), which the engine reports as
 * the agent having failed: that is how the test pins what the prompt must and must not tell the agent.
 *
 * The test sets the phase before each run: `pmPhase` (a project-manager run, whose AGENT_OUTPUT is the Spec step's) or `executorPhase` (an executor run that writes and
 * commits files in its workspace). The script keeps no state of its own besides the files in its directory.
 */
export interface FakeAgent {
  dir: string;
  /** The absolute path the runner is told the agent CLI is at. */
  binary: string;
  /** Directory holding `binary`, to be given the runner as its binary directory. */
  binDir: string;
  /** A project-manager run: asserts the prompt carries the file-list rules, then answers with `output` as its AGENT_OUTPUT. */
  pmPhase(output: unknown): void;
  /** An executor run: asserts the prompt does not tell the agent to push, writes `files` in its workspace and commits them. */
  executorPhase(files: Record<string, string>, opts?: { summary?: string }): void;
  /** How many times a real run (not a version or help call) was started, and with which phase. */
  runs(): string[];
  /** The prompt of the last real run. */
  lastPrompt(): string;
}

const SHELL = `#!/bin/sh
D='__DIR__'
case "$1" in
  --version) echo '__VERSION__ (Claude Code)'; exit 0;;
  --help) cat "$D/help.txt"; exit 0;;
  auth) cat "$D/auth.json"; exit 0;;
esac
cat > "$D/stdin.txt"
cat "$D/phase" >> "$D/runs.txt"
[ -f "$D/act.sh" ] || { echo "fake agent: no phase was set" >&2; exit 4; }
sh "$D/act.sh" || exit $?
cat "$D/stream.jsonl"
exit 0
`;

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The captured build's stream with its final result line carrying `resultText`, and one fresh session id. */
function streamWith(resultText: string): string {
  const session = randomUUID();
  const lines = fixtureText("stream.subscription.jsonl")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replaceAll("REDACTED-session_id", session));
  const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  if (last.type !== "result") throw new Error("fixture: the last stream line is not the result");
  last.result = resultText;
  lines[lines.length - 1] = JSON.stringify(last);
  return `${lines.join("\n")}\n`;
}

const envelope = (message: string, output: unknown): string => `${message}\n\n<!-- AGENT_OUTPUT -->\n\`\`\`json\n${JSON.stringify(output)}\n\`\`\`\n<!-- /AGENT_OUTPUT -->`;

export function createFakeAgent(): FakeAgent {
  const dir = mkdtempSync(path.join(tmpdir(), "r4d6-agent-"));
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  const binary = path.join(binDir, "agent");
  writeFileSync(binary, SHELL.replace("__DIR__", dir).replace("__VERSION__", DEFAULT_VERSION));
  chmodSync(binary, 0o755);
  const set = (file: string, text: string): void => writeFileSync(path.join(dir, file), text);
  set("help.txt", FULL_HELP);
  set("auth.json", authText("auth.claude_ai.json"));
  return {
    dir,
    binary,
    binDir,
    pmPhase(output) {
      set("phase", "pm\n");
      set("stream.jsonl", streamWith(envelope("Here is the Spec.", output)));
      set(
        "act.sh",
        [
          // The prompt is the real short-Spec prompt: it must carry the rules for the file list and must not tell the agent to change anything.
          `grep -q 'Also give \`acceptance_files\`' "${dir}/stdin.txt" || { echo "the project-manager prompt carries no acceptance_files rules" >&2; exit 3; }`,
          "",
        ].join("\n"),
      );
    },
    executorPhase(files, opts = {}) {
      set("phase", "executor\n");
      set("stream.jsonl", streamWith(envelope(opts.summary ?? "Done: the change is committed.", { summary: opts.summary ?? "Done." })));
      const paths = Object.keys(files);
      const lines = [
        // On a runner the platform publishes the commit and opens the pull request: a prompt that tells the agent to push (or to open a pull request) is the
        // sandbox prompt, and a run built from it would push with credentials this machine's agent does not have.
        `if grep -q 'git push' "${dir}/stdin.txt"; then echo "the executor prompt tells the agent to push" >&2; exit 3; fi`,
        ...paths.flatMap((file) => [`mkdir -p ${shellQuote(path.posix.dirname(file))}`, `printf '%s\\n' ${shellQuote(files[file]!)} > ${shellQuote(file)}`]),
        `git -c user.name=agent -c user.email=agent@example.test add -- ${paths.map(shellQuote).join(" ")}`,
        `git -c user.name=agent -c user.email=agent@example.test commit -q -m ${shellQuote("show the year in the footer")}`,
        "",
      ];
      set("act.sh", lines.join("\n"));
    },
    runs: () => (existsSync(path.join(dir, "runs.txt")) ? readFileSync(path.join(dir, "runs.txt"), "utf8").split("\n").filter((line) => line !== "") : []),
    lastPrompt: () => readFileSync(path.join(dir, "stdin.txt"), "utf8"),
  };
}
