#!/usr/bin/env python3
"""ON-13b1 spike gate: does a background Agent survive the end of a turn, with the host's stdin held open?

usage: engineSpike.py <claude path> <prompt file> <marker path> <hold seconds> [model]

It starts the engine host the way the supervisor will (the fixed argument vector below, nothing added), sends the prompt as ONE stream-json
user message, and keeps stdin open for <hold seconds> (the host's session stays alive, as in production) before closing it. Every stdout line of the
host is printed as `L <epoch seconds> <line>`; at the end it prints `M <marker mtime epoch seconds | none>` and `X <exit code | killed>`.
All the times come from this machine's one clock, so the judge can compare "the first turn ended" with "the background Agent wrote its marker".
The prompt text and the model's words are never interpreted here.
"""
import json, os, subprocess, sys, threading, time

HOST_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]


def main() -> int:
    claude, prompt_file, marker, hold = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
    env = dict(os.environ)
    if len(sys.argv) > 5 and sys.argv[5]:
        env["ANTHROPIC_MODEL"] = sys.argv[5]
        env["CLAUDE_CODE_SUBAGENT_MODEL"] = sys.argv[5]
    try:
        os.remove(marker)
    except FileNotFoundError:
        pass
    with open(prompt_file, "r", encoding="utf-8") as handle:
        prompt = handle.read()
    child = subprocess.Popen([claude] + HOST_ARGS, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, start_new_session=True)

    def pump() -> None:
        assert child.stdout is not None
        for raw in child.stdout:
            sys.stdout.write("L %.3f %s\n" % (time.time(), raw.decode("utf-8", "replace").rstrip("\n")))
            sys.stdout.flush()

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    assert child.stdin is not None
    child.stdin.write((json.dumps({"type": "user", "message": {"role": "user", "content": prompt}}) + "\n").encode())
    child.stdin.flush()
    deadline = time.time() + hold
    while time.time() < deadline and child.poll() is None:
        time.sleep(0.2)
    try:
        child.stdin.close()
    except OSError:
        pass
    ended = "killed"
    try:
        ended = str(child.wait(timeout=30))
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, 9)
        except ProcessLookupError:
            pass
    reader.join(timeout=5)
    mtime = "none"
    try:
        mtime = "%.3f" % os.stat(marker).st_mtime
    except FileNotFoundError:
        pass
    sys.stdout.write("M %s\nX %s\n" % (mtime, ended))
    return 0


sys.exit(main())
