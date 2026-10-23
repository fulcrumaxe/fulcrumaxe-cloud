import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { CLI_CWD_STUB_DIRS, CLI_CWD_STUB_FILES, CLI_EXCLUDE_HEADER, CLI_HOME_STUB_DIRS, CLI_HOME_STUB_FILES } from "../../src/daemon/cliStubs.js";
import { FULL_HELP } from "../engines/claude/harness.js";

/** The build whose start-up this fake reproduces. */
export const STUBBING_VERSION = "2.1.309";

/** What the real CLI's scrub start-up names for its exclude block (the start directory's file list, root-anchored). */
export const CLI_EXCLUDE_NAMES: readonly string[] = ["bunfig.toml", "package.json", ".npmrc", ".yarnrc", ".yarnrc.yml", ".gitmodules", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", ".env", ".env.local", ".env.development", ".env.development.local", ".env.test", ".env.test.local", ".env.production", ".env.production.local"];

export interface StubbingClaude {
  binary: string;
  /** One entry per start: the directory it started in, its first two arguments, and the scrub setting it saw. */
  calls(): Array<{ cwd: string; args: string; scrub: string }>;
}

/**
 * A real-contract stand-in for the installed Claude Code CLI's start-up (build 2.1.309, read off its bundle; D#6 RUNNER-CWD-1). With
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` on (1, true, yes, on) it refuses to start without bubblewrap on PATH, as the real one does, and otherwise
 * makes exactly what the real one makes before it answers anything: empty files (opened for append, never truncated) and directories in
 * `$HOME` and in the directory it was started in, and, when that directory has a `.git`, the `info`, `modules`, `worktrees` and `glab-cli`
 * directories (not recursively), an empty `config.worktree`, a `commondir` of `.` (exclusive create) and one block appended to
 * `info/exclude`. The real build also touches one shared file in `/tmp`; that is left out so the test leaves the machine's `/tmp` alone.
 * Then `--version`, `--help` and `auth status` answer; any other call is a model turn that prints one result line.
 */
export function makeStubbingClaude(dir: string): StubbingClaude {
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  // The program is bin/agent and bin/claude a link to it: a PATH search for the CLI finds it (and resolves the link, as the runner does), while the
  // repo's model-call guard (FX_FORBID_MODEL_CALLS=1, which CI sets) still refuses any start of a program named for the real CLI.
  const binary = path.join(dir, "bin", "agent");
  writeFileSync(path.join(dir, "help.txt"), FULL_HELP);
  const q = (items: readonly string[], base: string): string => items.map((name) => `"${base}/${name}"`).join(" ");
  const exclude = `\\n${CLI_EXCLUDE_HEADER}\\n${CLI_EXCLUDE_NAMES.map((name) => `/${name}`).join("\\n")}`;
  const script = `#!/bin/sh
D='${dir}'
printf '%s\\t%s %s\\t%s\\n' "$(pwd)" "$1" "$2" "\${CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:-}" >> "$D/calls.log"
case "\${CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:-}" in
  1|true|yes|on)
    command -v bwrap >/dev/null 2>&1 || { echo "bubblewrap is required for subprocess env scrubbing and isolation." >&2; exit 1; }
    e="$HOME"; n="$(pwd)"
    for f in ${q(CLI_HOME_STUB_FILES, "$e")} ${q(CLI_CWD_STUB_FILES, "$n")}; do mkdir -p "$(dirname "$f")" 2>/dev/null; : >> "$f" 2>/dev/null; done
    for d in ${q(CLI_HOME_STUB_DIRS, "$e")} ${q(CLI_CWD_STUB_DIRS, "$n")}; do mkdir -p "$d" 2>/dev/null; done
    for d in info modules worktrees glab-cli; do mkdir "$n/.git/$d" 2>/dev/null; done
    if [ -d "$n/.git" ]; then
      : >> "$n/.git/config.worktree" 2>/dev/null
      (set -C; printf . > "$n/.git/commondir") 2>/dev/null
      printf '${exclude}' >> "$n/.git/info/exclude" 2>/dev/null
    fi;;
esac
case "$1" in
  --version) echo '${STUBBING_VERSION} (Claude Code)'; exit 0;;
  --help) cat "$D/help.txt"; exit 0;;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0;;
esac
cat > /dev/null
echo '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"00000000-0000-4000-8000-000000000000"}'
exit 0
`;
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  symlinkSync("agent", path.join(dir, "bin", "claude"));
  return {
    binary,
    calls: () => {
      const log = path.join(dir, "calls.log");
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8").replace(/\n$/, "").split("\n").map((line) => {
        const [cwd = "", args = "", scrub = ""] = line.split("\t");
        return { cwd, args, scrub };
      });
    },
  };
}

/** A `bwrap` stand-in for PATH: the real CLI only checks that one is there before its scrub start-up. */
export function fakeBwrapDir(dir: string): string {
  const bin = path.join(dir, "fakebwrap");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "bwrap"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "bwrap"), 0o755);
  return bin;
}

/** Every entry under `dir`, relative, sorted (directories with a trailing slash), not following links. */
export function treeOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSafe(path.join(dir, rel))) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push(`${child}/`);
        walk(child);
      } else out.push(child);
    }
  };
  walk("");
  return out.sort();
}

function readdirSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    // fx-swallow-ok: an unreadable directory lists as empty
    return [];
  }
}
