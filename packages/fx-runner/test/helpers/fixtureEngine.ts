import { tgzOf, EPIC_TEMPLATE, type TarSpec } from "./tarBuilder.js";

/**
 * A fixture ENGINE release archive that follows the contract the cloud's setup relies on (the engine's non-interactive coldstart): `loop-bootstrap/bootstrap.sh --repo R --branch B <path>`, then
 * `scripts/coldstart.sh --path P --name N --language L --mode M --non-interactive --answers-file F --repo-visibility V --status-fd 3`, then `scripts/coldstart-interview/generate.py --answers A --out D`.
 * It is small on purpose: it checks the arguments it is given, writes what the real scripts write (a branch, a project file, answers recorded in the state directory, status lines on fd 3) and calls `gh` the
 * way the real bootstrap does, so the refusing shim is exercised. `coreTopics` is the list the fixture holds answered; a topic it asks for that the host did not give exits 3 `missing_topic:<id>`.
 */
export interface FixtureEngineOptions {
  coreTopics?: readonly string[];
  /** Extra files, for hostile-bundle cases (a script of the engine that writes them is added by the caller through `extraWrite`). */
  extraWrite?: string;
  /** Print these lines (and nothing more) as the status stream and exit 0: a stream the host must refuse. */
  statusLines?: readonly string[];
  /** Exit with this code after the normal status lines but without the final `done` line. */
  exitWithoutDone?: number;
  bootstrapExit?: number;
  /** The real bootstrap installs hooks in the repository; this one installs a pre-commit that always fails and a post-commit that leaves a marker file, neither of which the install commit may run. */
  failingHook?: boolean;
  /** The real bootstrap may commit. After a first engine commit, `second` makes another, `link_removed` adds a link out of the tree in a second commit and removes it in a third, `link_kept` adds it and leaves it. */
  bootstrapCommits?: "second" | "link_removed" | "link_kept";
}

const BOOTSTRAP_COMMITS: Record<NonNullable<FixtureEngineOptions["bootstrapCommits"]>, string[]> = {
  second: ['echo more >"$W/engine-note.txt"', 'git -C "$W" add -A', 'C commit -qm "engine two"'],
  link_removed: ['ln -s ../../outside "$W/escape"', 'git -C "$W" add -A', 'C commit -qm "engine link"', 'rm "$W/escape"', 'git -C "$W" add -A', 'C commit -qm "engine unlink"'],
  link_kept: ['ln -s ../../outside "$W/escape"', 'git -C "$W" add -A', 'C commit -qm "engine link"'],
};

export const FIXTURE_TOP = "engine-fixture";

export function fixtureEngineFiles(options: FixtureEngineOptions = {}): TarSpec[] {
  const core = (options.coreTopics ?? ["identity", "stack", "deploy", "autonomy", "mission"]).join(" ");
  const bootstrap = [
    "#!/usr/bin/env bash",
    "set -eu",
    'repo=""; branch=""',
    'while [ "$#" -gt 1 ]; do case "$1" in --repo) repo=$2; shift 2;; --branch) branch=$2; shift 2;; *) shift;; esac; done',
    "W=$1",
    '[ "$(git -C "$W" rev-parse --abbrev-ref HEAD)" = "$branch" ]',
    'mkdir -p "$W/.autonomous-team"',
    'printf \'{"repo":"%s"}\\n\' "$repo" >"$W/.autonomous-team/project.json"',
    "# the real bootstrap calls gh whenever it is on PATH (labels, the team-log issue); here it must be refused",
    'gh label create bug >/dev/null 2>&1 || true',
    ...(options.failingHook === true ? ['mkdir -p "$W/.git/hooks"; printf \'#!/bin/sh\\nexit 1\\n\' >"$W/.git/hooks/pre-commit"; printf \'#!/bin/sh\\ntouch hook-ran.txt\\n\' >"$W/.git/hooks/post-commit"; chmod 755 "$W/.git/hooks/pre-commit" "$W/.git/hooks/post-commit"'] : []),
    ...(options.bootstrapCommits === undefined ? [] : ['C() { git -C "$W" -c user.name=eng -c user.email=eng@example.test "$@"; }', 'git -C "$W" add -A', 'C commit -qm "engine one"', ...BOOTSTRAP_COMMITS[options.bootstrapCommits]]),
    ...(options.bootstrapExit === undefined ? [] : [`exit ${String(options.bootstrapExit)}`]),
  ].join("\n");
  const coldstart = [
    "#!/usr/bin/env bash",
    "set -eu",
    'while [ "$#" -gt 0 ]; do case "$1" in --path) P=$2; shift 2;; --name) N=$2; shift 2;; --language) L=$2; shift 2;; --mode) M=$2; shift 2;; --non-interactive) shift;; --answers-file) A=$2; shift 2;; --repo-visibility) V=$2; shift 2;; --status-fd) FD=$2; shift 2;; *) echo "unknown $1" >&2; exit 1;; esac; done',
    'status() { printf "%s\\n" "$1" >&"$FD"; }',
    "# the answers file is canonical JSON, so the resume journal key is stable",
    'python3 -c \'import json,sys; t=open(sys.argv[1]).read(); sys.exit(0 if json.dumps(json.loads(t), sort_keys=True, separators=(",", ":")) == t else 1)\' "$A"',
    'echo "coldstart output that must not be read as status"',
    ...(options.statusLines === undefined ? [] : [...options.statusLines.map((line) => `status ${JSON.stringify(line)}`), "exit 0"]),
    "status 'step=preflight state=started'; status 'step=preflight state=ok'",
    "status 'step=interview state=started'",
    `for t in ${core}; do python3 -c 'import json,sys; d=json.load(open(sys.argv[1])).get(sys.argv[2]); sys.exit(0 if isinstance(d, dict) and d else 1)' "$A" "$t" || { status "step=interview state=failed code=missing_topic:$t"; exit 3; }; done`,
    'D="$AUTONOMOUS_TEAM_STATE_DIR/coldstart/s1"; mkdir -p "$D"',
    'python3 -c \'import json,sys; a=json.load(open(sys.argv[1])); a["mode"]={"project_kind": sys.argv[2]}; json.dump({"topics": a}, open(sys.argv[3], "w"), indent=2, sort_keys=True)\' "$A" "$M" "$D/answers.json"',
    "status 'step=interview state=ok'",
    "status 'step=wiring state=started'",
    'printf \'{"name":"%s","language":"%s","visibility":"%s"}\\n\' "$N" "$L" "$V" >"$P/.autonomous-team/wired.json"',
    ...(options.extraWrite === undefined ? [] : [options.extraWrite]),
    "status 'step=wiring state=ok'",
    "status 'step=deps state=started'; status 'step=deps state=ok'",
    "status 'step=labels state=skipped code=cloud_owned'",
    "status 'step=sandbox_hook state=started'; status 'step=sandbox_hook state=ok'",
    "status 'step=bundle state=ok'",
    ...(options.exitWithoutDone === undefined ? ["status 'step=done state=ok'"] : [`exit ${String(options.exitWithoutDone)}`]),
  ].join("\n");
  const generate = [
    "import argparse, json, os",
    "p = argparse.ArgumentParser()",
    'p.add_argument("--answers"); p.add_argument("--out")',
    "a = p.parse_args()",
    "topics = json.load(open(a.answers))['topics']",
    "os.makedirs(a.out, exist_ok=True)",
    "json.dump({'dials': {k: v for k, v in sorted(topics['autonomy'].items())}}, open(a.out + '/config.json', 'w'), indent=2, sort_keys=True)",
    "open(a.out + '/CLAUDE.project.md', 'w').write('# ' + topics['identity']['project_name'] + '\\n')",
  ].join("\n");
  const signals = ["#!/usr/bin/env bash", "set -eu", 'if [ -f "$2/package.json" ]; then echo \'{"detected_languages":["typescript"],"framework_guess":"next","package_manager":"pnpm"}\'; else echo \'{"detected_languages":["python"],"framework_guess":null,"package_manager":null}\'; fi'].join("\n");
  const manifest = JSON.stringify({ version: 1, topics: [{ id: "stack", questions: [{ id: "package_manager", choices: ["pip", "npm", "yarn", "pnpm", "cargo", "go-mod", "other"] }] }] });
  const file = (rel: string, body: string, mode = 0o644): TarSpec => ({ name: `${FIXTURE_TOP}/${rel}`, body, mode });
  return [
    { name: `${FIXTURE_TOP}/`, type: "5", mode: 0o755 },
    file("scripts/coldstart-templates/epic/epic.md", EPIC_TEMPLATE),
    file("loop-bootstrap/bootstrap.sh", bootstrap, 0o755),
    file("scripts/coldstart.sh", coldstart, 0o755),
    file("scripts/coldstart-interview/generate.py", generate, 0o755),
    file("scripts/coldstart-interview/repo-signals.sh", signals, 0o755),
    file("scripts/coldstart-interview/questions.json", manifest),
  ];
}

export const fixtureEngineTgz = (options: FixtureEngineOptions = {}): Buffer => tgzOf(fixtureEngineFiles(options));
