import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REQUIRED_FLAGS } from "../../../src/engines/claude/argv.js";
import { SUBSCRIPTION_TOKEN_VAR } from "../../../src/job/cleanEnv.js";

/**
 * The agent CLI stand-in shared by the real-VM job suites (D#587 B-5b-3c-v): one small program that starts like the CLI (version and help), reads the prompt, writes one file and one commit in its
 * workspace, a probe file outside it, and reports what its environment held (under labels the run log does not redact: it hides any value that follows the word token). The same program is
 * run in a guest and, for the engine comparison, under the OS sandbox, so the two engines are given exactly the same agent.
 */
export const AGENT_PROBE = "/tmp/fx-agent-probe";
export const CLI = "/tmp/fx-scripted-claude";
export const FILE_IN_GUEST = "written in the guest\n";
/** A prompt that holds this word makes the program start and then never end: the agent a stop has to end. */
export const HANG = "FXMODE-HANG";
/** A prompt that holds this word makes the program search every disk-backed file of the guest for the token, with a planted control. */
export const DISKSCAN = "FXMODE-DISKSCAN";
/** A prompt that holds this word makes the program call out the way the real CLI and git would: the model host by its base URL, github.com for git, and a host outside the policy by both relays. */
export const RELAYS = "FXMODE-RELAYS";

export interface ScriptTools {
  /** The interpreter the program starts under: the guest's own, or this machine's for the OS sandbox. */
  python: string;
  /** The git the program commits with. */
  git: string;
  /** The token, when the program is to search for it: it is held as two halves, so the program's own text never contains it. */
  needle?: string;
}

export function cliScript(tokenSha: string, init: string, result: string, tools: ScriptTools): string {
  const half = tools.needle === undefined ? 0 : Math.floor(tools.needle.length / 2);
  return `#!${tools.python}
import hashlib, json, os, subprocess, sys, time
REQ = ${JSON.stringify(REQUIRED_FLAGS)}
INIT = ${JSON.stringify(init)}
RESULT = ${JSON.stringify(result)}
TOKEN_SHA = ${JSON.stringify(tokenSha)}
VAR = ${JSON.stringify(SUBSCRIPTION_TOKEN_VAR)}
PROBE = ${JSON.stringify(AGENT_PROBE)}
GIT = ${JSON.stringify(tools.git)}
NEEDLE_A = ${JSON.stringify(tools.needle?.slice(0, half) ?? "")}
NEEDLE_B = ${JSON.stringify(tools.needle?.slice(half) ?? "")}
if "--version" in sys.argv:
    print("2.1.295 (Claude Code)"); sys.exit(0)
if "--help" in sys.argv:
    print("\\n".join("  " + f for f in REQ)); sys.exit(0)
prompt = sys.stdin.read()
def emit(o):
    sys.stdout.write((o if isinstance(o, str) else json.dumps(o, separators=(",", ":"))) + "\\n"); sys.stdout.flush()
emit(INIT)
if ${JSON.stringify(HANG)} in prompt:
    while True: time.sleep(0.05)
tok = os.environ.get(VAR)
facts = ["cli_sees=" + ("absent" if tok is None else "match" if hashlib.sha256(tok.strip().encode()).hexdigest() == TOKEN_SHA else "wrong")]
scrub = os.environ.get("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB") == "1"
facts.append("scrub_pin=" + str(scrub))
# what the real CLI does with that pin: a child it starts (the Bash tool) gets the environment without the token
child_env = {k: v for k, v in os.environ.items() if not (scrub and k == VAR)}
child = subprocess.run(["sh", "-c", "printenv " + VAR + " >/dev/null && echo present || echo absent"], env=child_env, capture_output=True, text=True).stdout.strip()
facts.append("child_sees=" + child)
if ${JSON.stringify(DISKSCAN)} in prompt:
    # What the guest keeps on a disk: (1) which mounted filesystems are disk-backed and writable (the guest's root disk is mounted read-only, so a token could not be written to it), and (2) every regular
    # file of every disk-backed filesystem (find stays on one disk), read as root of the guest, searched for the token. The control proves the search works: the same command, run over a file this
    # program plants in memory-backed space holding the token, must find it, so "nothing found" is never reported without it.
    needle = NEEDLE_A + NEEDLE_B
    memory = {"proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2", "mqueue", "ramfs", "securityfs", "debugfs", "tracefs", "configfs", "autofs", "bpf", "fusectl", "hugetlbfs", "pstore"}
    disks = [m.split() for m in open("/proc/mounts").read().split("\\n") if m != ""]
    disks = [(m[1], m[2], m[3].split(",")[0]) for m in disks if m[2] not in memory]
    writable = [d[0] + ":" + d[1] for d in disks if d[2] != "ro"]
    facts.append("disk_writable=" + ("none" if not writable else ",".join(writable)))
    facts.append("disk_mounts=" + ",".join(d[0] + ":" + d[1] + ":" + d[2] for d in disks))
    control_dir = "/var/tmp"
    control = control_dir + "/fx-needle-control"
    with open(control, "w") as f:
        f.write("x" + needle + "x")
    def scan(start, stay):
        sh = "find " + start + (" -xdev" if stay else "") + ' -type f -size -64M -print0 | xargs -0 -r grep -lFa -e "$NEEDLE" 2>/dev/null; true'
        out = subprocess.run(["sudo", "-n", "env", "NEEDLE=" + needle, "sh", "-c", sh], capture_output=True, text=True, timeout=600)
        return [l for l in out.stdout.split("\\n") if l != ""], out
    found_control, out = scan(control_dir, False)
    os.remove(control)
    hits, _ = scan("/", True)
    if found_control != [control]: facts.append("disk_scan=control_missed(rc=%s,err=%s)" % (out.returncode, out.stderr.strip()[:200].replace(";", ",").replace("\\n", " ")))
    elif hits: facts.append("disk_scan=found:" + ",".join(hits))
    else: facts.append("disk_scan=clean")
if ${JSON.stringify(RELAYS)} in prompt:
    # The calls a job's tools make, through the guest's own relays and the environment the runner set (ANTHROPIC_BASE_URL, the proxy variables, git's rewrite): each is reported as what it got, never raised.
    import http.client, urllib.error, urllib.request
    def attempt(f):
        try: return f()
        except urllib.error.HTTPError as e: return "http_%d" % e.code
        except Exception as e: return "failed_" + type(e).__name__
    def model():
        req = urllib.request.Request(os.environ.get("ANTHROPIC_BASE_URL", "") + "/v1/messages", data=b"{}", headers={"content-type": "application/json", "x-api-key": "guest-placeholder"})
        with urllib.request.urlopen(req, timeout=60) as r: return "%d:%s" % (r.status, r.read().decode().strip()[:120])
    def git_remote():
        out = subprocess.run([GIT, "ls-remote", "https://github.com/fx-test/repo.git"], capture_output=True, text=True, timeout=60)
        return "ok:" + out.stdout.strip()[:120] if out.returncode == 0 else "refused"
    def tunnel(): return "%d" % urllib.request.urlopen("https://outside.example.test/", timeout=60).status
    def reverse():
        c = http.client.HTTPConnection("127.0.0.1", 80, timeout=60)
        c.request("GET", "/", headers={"Host": "outside.example.test"})
        return "http_%d" % c.getresponse().status
    facts.append("relay_model=" + attempt(model))
    facts.append("relay_git=" + attempt(git_remote))
    facts.append("relay_outside_tunnel=" + attempt(tunnel))
    facts.append("relay_outside_reverse=" + attempt(reverse))
with open(PROBE, "w") as f:
    f.write("probe written by the agent\\n")
facts.append("probe_written=" + str(os.path.exists(PROBE)))
with open("feature.txt", "w") as f:
    f.write(${JSON.stringify(FILE_IN_GUEST)})
ident = ["-c", "user.name=agent", "-c", "user.email=agent@example.test"]
subprocess.run([GIT] + ident + ["add", "-A"], check=True)
subprocess.run([GIT] + ident + ["commit", "-qm", "agent change"], check=True)
facts.append("workdir=" + os.getcwd())
r = json.loads(RESULT)
r["result"] = "; ".join(facts)
emit(r)
`;
}

/** The path of a tool on this machine, or undefined. */
export function onPath(name: string): string | undefined {
  const out = spawnSync("which", [name], { encoding: "utf8" });
  return out.status === 0 && out.stdout.trim() !== "" ? out.stdout.trim() : undefined;
}

/** Whether this machine's bubblewrap can make the namespaces a job's sandbox needs (a hosted Ubuntu may refuse them). */
export function bwrapUsable(): boolean {
  const bwrap = onPath("bwrap");
  if (bwrap === undefined) return false;
  return spawnSync(bwrap, ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "true"], { encoding: "utf8" }).status === 0;
}

/**
 * A tool directory for a run on the OS sandbox: the real bubblewrap, socat and git, and a `claude` that runs the shared program (the program file sits beside it, so the sandbox can read
 * it), except for `auth`, which answers from `authBinary` (the harness' fake). Returns the directory, or undefined where a tool is missing.
 */
export function osToolbin(root: string, script: string, authBinary: string): string | undefined {
  const dir = path.join(root, "os-toolbin");
  mkdirSync(dir);
  for (const name of ["bwrap", "socat", "git", "sh", "env"]) {
    const found = onPath(name);
    if (found === undefined) return undefined;
    symlinkSync(found, path.join(dir, name));
  }
  const python = onPath("python3");
  if (python === undefined) return undefined;
  writeFileSync(path.join(dir, "agent.py"), script);
  writeFileSync(path.join(dir, "claude"), `#!/bin/sh\ncase "$1" in auth) exec ${authBinary} "$@";; esac\nexec ${python} ${path.join(dir, "agent.py")} "$@"\n`);
  chmodSync(path.join(dir, "claude"), 0o755);
  return dir;
}
