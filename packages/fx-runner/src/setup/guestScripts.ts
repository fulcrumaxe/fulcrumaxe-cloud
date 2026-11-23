/**
 * D#845 ON-8d: what a project setup runs in its guest: three fixed commands, `bootstrap`, `coldstart`, `finalize`. The host's values go in as separate arguments after the script, never spliced into it.
 *  - Every command starts with one prelude: `HOME` and the engine's state directory below the stage directory, and a refusing `gh` first on PATH (it logs each call to `gh.log`; the guest has no GitHub to reach).
 *  - `coldstart` merges the host's answers with the engine's own repo scan into canonical JSON (a stable resume key), then runs the engine with `--status-fd 3 3>&1 1>&2`: status on stdout, engine output on stderr.
 *  - `finalize` runs the engine's generator, copies the plan files in and makes ONE commit with a fixed identity and the job's issue time as both dates, so a re-run gives the same commit id.
 * The engine and the plan files go in as flat files in the stage directory (a nested directory made by the guest's file transfer would belong to root).
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { RenderedFile } from "./render.js";
import { guestEnvOf } from "../vm/sandboxd/guestEnv.js";
import type { SdkSandbox } from "../vm/sandboxd/sdkSlice.js";
import { DEFAULT_GUEST_PATHS, runInGuest, type GuestPaths } from "../vm/workspace/guestWorkspace.js";

export class SetupGuestError extends Error {
  constructor(readonly code: "engine_too_large" | "plan_path" | "send_failed" | "unpack_failed") {
    super(code);
    this.name = "SetupGuestError";
  }
}

const PRELUDE = [
  "set -eu",
  "umask 022",
  "W=$1; S=$2; E=$S/engine; shift 2",
  'export HOME="$S/home" COLDSTART_STATE_ROOT="$S/state" AUTONOMOUS_TEAM_STATE_DIR="$S/state" GIT_TERMINAL_PROMPT=0',
  'mkdir -p "$HOME" "$S/state" "$S/shim"',
  String.raw`printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"%s/gh.log"\necho "gh: not logged in" >&2\nexit 1\n' "$S" >"$S/shim/gh"`,
  'chmod 755 "$S/shim/gh"',
  'PATH="$S/shim:$PATH"; export PATH',
];

/** args: branch, owner/name. */
export const BOOTSTRAP = [...PRELUDE, "BRANCH=$1; REPO=$2", 'cd "$W"', 'git checkout -q -b "$BRANCH"', 'bash "$E/loop-bootstrap/bootstrap.sh" --repo "$REPO" --branch "$BRANCH" "$W"'].join("\n");

/** The host's answers plus the engine's scan of the repo, as the answers file the engine reads. Prints the `--language` it settled on. */
const MERGE = [
  "import json, os, sys",
  "e, w, s, mode = sys.argv[1:5]",
  'a = json.load(open(s + "/host-answers.json"))',
  'manifest = json.load(open(e + "/scripts/coldstart-interview/questions.json"))',
  'choices = {q["id"]: q.get("choices") or [] for t in manifest["topics"] for q in t.get("questions", [])}',
  'if mode == "existing":',
  '    sig = json.load(open(s + "/signals.json"))',
  '    langs = sig.get("detected_languages") or []',
  '    lang = langs[0] if langs and langs[0] in ("python", "typescript", "javascript", "go", "rust") else "other"',
  '    pm = sig.get("package_manager")',
  '    fw = sig.get("framework_guess") or "none"',
  '    a["stack"] = {"primary_language": lang, "runtime_framework": fw, "package_manager": pm if pm in choices.get("package_manager", []) else "other", "test_framework": "pytest" if lang == "python" else "unknown", "has_frontend": "yes" if fw in ("next", "react", "vue", "svelte", "angular", "nuxt", "vite") else "no"}',
  'flows = w + "/.github/workflows"',
  'a.setdefault("deploy", {})["ci_provider"] = "github-actions" if os.path.isdir(flows) and os.listdir(flows) else "none"',
  'open(s + "/answers.json", "w").write(json.dumps(a, sort_keys=True, separators=(",", ":")))',
  'print({"typescript": "typescript", "javascript": "typescript", "python": "python", "rust": "rust"}.get(a["stack"]["primary_language"], "polyglot"))',
].join("\n");

/** args: the merge program, project name, mode (existing or new), repo visibility. */
export const COLDSTART = [
  ...PRELUDE,
  "PROGRAM=$1; NAME=$2; MODE=$3; VIS=$4",
  'cd "$W"',
  'bash "$E/scripts/coldstart-interview/repo-signals.sh" --repo-path "$W" >"$S/signals.json"',
  'LANGUAGE=$(python3 -I -c "$PROGRAM" "$E" "$W" "$S" "$MODE")',
  'bash "$E/scripts/coldstart.sh" --path "$W" --name "$NAME" --language "$LANGUAGE" --mode "$MODE" --non-interactive --answers-file "$S/answers.json" --repo-visibility "$VIS" --status-fd 3 3>&1 1>&2',
].join("\n");

/** args: engine version, the commit time (the job's `issued_at`), the base commit the install commit sits on. */
export const FINALIZE = [
  ...PRELUDE,
  "V=$1; WHEN=$2; BASE=$3",
  'ANS=$(find "$S/state" -type f -name answers.json -path "*/coldstart/*")',
  '[ -n "$ANS" ] && [ "$(printf \'%s\\n\' "$ANS" | wc -l)" -eq 1 ]',
  'python3 -I "$E/scripts/coldstart-interview/generate.py" --answers "$ANS" --out "$W/.autonomous-team"',
  `while IFS="$(printf '\\t')" read -r i p; do mkdir -p "$W/$(dirname -- "$p")"; cp -- "$S/plan-$i" "$W/$p"; done <"$S/plan.lst"`,
  'cd "$W"',
  "# whatever commits the engine or the guest made are folded away: the one install commit sits directly on the base and holds the final tree",
  'git reset --soft "$BASE"',
  "git add -A",
  'GIT_AUTHOR_NAME=fulcrumaxe GIT_AUTHOR_EMAIL=runner@localhost GIT_COMMITTER_NAME=fulcrumaxe GIT_COMMITTER_EMAIL=runner@localhost GIT_AUTHOR_DATE="$WHEN" GIT_COMMITTER_DATE="$WHEN" git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -q --no-verify -m "Install the fulcrumaxe engine $V"',
].join("\n");

const UNPACK_ENGINE = ["set -eu", "umask 022", "S=$2; SHA=$3; E=$S/engine", 'rm -rf "$E"; mkdir -p "$E"', 'base64 -d "$S/engine.b64" >"$S/engine.tgz"', 'rm -f "$S/engine.b64"', '[ "$(sha256sum "$S/engine.tgz" | cut -d" " -f1)" = "$SHA" ]', 'tar -xzf "$S/engine.tgz" -C "$E" --strip-components=1 --no-same-owner --no-same-permissions', 'rm -f "$S/engine.tgz"'].join("\n");

/** The largest engine archive (compressed) one guest file frame carries once it is base64. */
const MAX_ENGINE_GZ_BYTES = 96 * 1024 * 1024;
const PLAN_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** `engineTar`: the engine's decompressed tar, already hashed and read entry by entry on the host. `answers`: topic to question to value (`hostAnswers`). */
export interface SetupInputs { engineTar: Buffer; answers: unknown; files: readonly RenderedFile[] }

/** Puts the verified engine, the host's answers and the rendered plan files into the guest's stage directory. The stage directory exists (the workspace went in first). */
export async function sendSetupInputs(guest: SdkSandbox, input: SetupInputs, paths: GuestPaths = DEFAULT_GUEST_PATHS): Promise<void> {
  const gz = gzipSync(input.engineTar);
  if (gz.length > MAX_ENGINE_GZ_BYTES) throw new SetupGuestError("engine_too_large");
  if (input.files.some((file) => !PLAN_PATH.test(file.path) || file.path.split("/").includes(".."))) throw new SetupGuestError("plan_path");
  const at = (name: string): string => `${paths.stage}/${name}`;
  try {
    await guest.writeFiles([
      { path: at("engine.b64"), content: gz.toString("base64"), mode: 0o644 },
      { path: at("host-answers.json"), content: JSON.stringify(input.answers), mode: 0o644 },
      { path: at("plan.lst"), content: input.files.map((file, i) => `${String(i)}\t${file.path}\n`).join(""), mode: 0o644 },
      ...input.files.map((file, i) => ({ path: at(`plan-${String(i)}`), content: file.content, mode: 0o644 })),
    ]);
  } catch {
    // fx-swallow-ok: replaced by the closed code; the daemon's error text could hold a path
    throw new SetupGuestError("send_failed");
  }
  const sha = createHash("sha256").update(gz).digest("hex");
  const ran = await runInGuest(guest, { cmd: "sh", args: ["-c", UNPACK_ENGINE, "fx-engine", paths.workspace, paths.stage, sha] }, 10 * 60_000).catch(() => undefined); // fx-swallow-ok: an unreachable guest is the closed code just below
  if (ran?.exitCode !== 0) throw new SetupGuestError("unpack_failed");
}

export interface SetupCommand { script: string; args: readonly string[]; limitMs: number; onText?: (stream: "stdout" | "stderr", text: string) => void | "stop"; signal?: AbortSignal }
export const MERGE_PROGRAM = MERGE;

/** Runs one of the three commands in the guest under the guest's clean environment. */
export function runSetupCommand(guest: SdkSandbox, command: SetupCommand, paths: GuestPaths = DEFAULT_GUEST_PATHS): ReturnType<typeof runInGuest> {
  return runInGuest(guest, { cmd: "sh", args: ["-c", command.script, "fx-setup", paths.workspace, paths.stage, ...command.args], env: guestEnvOf({}) }, command.limitMs, 4 * 1024, command.onText, command.signal);
}
