#!/usr/bin/env python3
"""ON-13b1 DRY run, inside the guest: the image's own fx-engine-supervisor bundle (node) with a stand-in for the model CLI. No model, no sign-in, no network.

usage: engineSupervisorDry.py <work dir> <file holding the token canary>

The canary is read from a file (and the file removed) so that it is never an argument of the guest agent's command record.

It starts the bundle the way engine-bridge.py does (the unprivileged user's own process, FX_ENGINE_DIR and FX_ENGINE_SOCK set, FX_ENGINE_CLAUDE naming the stand-in),
then drives the channel over its unix socket: token_put, tick, events_read, stop. The stand-in prints an `init` line, answers each user line with a `result`, and after
the FIRST result starts a background process in its own process group that writes a marker file 4 seconds later: the marker's time against the result's proves the host
and what it started live on after a turn ends (the supervisor keeps stdin open and does not kill the group), with no second command from a model. It prints one line,
`DRY_REPORT <json>`, of closed fields (booleans, counts and seconds): never a byte of the token or of anything the stand-in said.
"""
import calendar, json, os, socket, struct, subprocess, sys, time

work, canary_file = sys.argv[1], sys.argv[2]
with open(canary_file) as f:
    canary = f.read().strip()
os.unlink(canary_file)
state, sock_path, record, marker = work + "/state", work + "/channel.sock", work + "/record.jsonl", work + "/marker"
checkout = work + "/checkout"
os.makedirs(checkout, exist_ok=True)


def ask(header, body=b""):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(sock_path)
    raw = json.dumps(header).encode()
    s.sendall(struct.pack(">I", len(raw)) + raw + body)
    got = b""
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        got += chunk
    s.close()
    return json.loads(got[4:4 + struct.unpack(">I", got[:4])[0]])


def until(cond, seconds):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.2)
    return False


def lines(after=0):
    return [json.loads(l) for l in ask({"op": "events_read", "after": after}).get("lines", [])]


report = {"ready": False}
env = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/vercel"), "FX_ENGINE_DIR": state, "FX_ENGINE_SOCK": sock_path, "FX_ENGINE_CLAUDE": work + "/host-standin"}
sup = subprocess.Popen(["/opt/fx/bin/node", "/usr/lib/fx/fx-engine-supervisor.mjs"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
try:
    report["ready"] = until(lambda: os.path.exists(sock_path), 20)
    report["mode_0600"] = report["ready"] and (os.stat(sock_path).st_mode & 0o777) == 0o600
    report["no_config"] = ask({"op": "tick", "kind": "loop"}) == {"ok": False, "code": "no_session_config"}
    report["unverified"] = ask({"op": "command", "command": {}}) == {"ok": False, "code": "command_unverified"}
    report["bad_request"] = ask({"op": "exec"}) == {"ok": False, "code": "bad_request"}
    with open(state + "/session.json", "w") as f:
        json.dump({"repo_gh_id": "424242", "repo_checkout": checkout}, f)
    os.chmod(state + "/session.json", 0o600)
    report["token_put"] = ask({"op": "token_put", "name": "claude", "size": len(canary)}, canary.encode()) == {"ok": True}
    report["tick"] = ask({"op": "tick", "kind": "loop"}) == {"ok": True, "started": True}
    report["usage_tick"] = until(lambda: any(e.get("kind") == "usage_tick" for e in lines()), 30)
    ticks = [e for e in lines() if e.get("kind") == "usage_tick"]
    report["usage_exact"] = bool(ticks) and [ticks[0].get(k) for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "model_tier")] == [11, 22, 33, 44, "claude-haiku-4-5"]
    report["marker_after_turn"] = until(lambda: os.path.exists(marker), 30)
    stand = [json.loads(l) for l in open(record)] if os.path.exists(record) else []
    report["token_in_host_env"] = any(e.get("event") == "start" and e.get("tokenSeen") is True for e in stand)
    report["stdin_open_until_marker"] = report["marker_after_turn"] and not any(e.get("event") == "stdin_end" for e in stand)
    if ticks and report["marker_after_turn"]:
        t0 = calendar.timegm(time.strptime(ticks[0]["ts"][:19], "%Y-%m-%dT%H:%M:%S"))
        report["marker_after_result_s"] = round(os.stat(marker).st_mtime - t0, 1)
    stopped = ask({"op": "stop", "reason": "machine_shutdown"})
    report["stop"] = stopped.get("ok") is True and stopped.get("survivors") == 0 and stopped.get("token_wiped") is True
    pid = [e for e in stand if e.get("event") == "start"][0]["pid"] if stand else -1

    def gone():
        try:
            os.kill(pid, 0)
            return False
        except OSError:
            return True

    report["host_gone"] = until(gone, 15)
    # the program ENDS after a channel stop (no copy of the token may outlive it): the socket goes away, so a tick after the stop either gets `stopped` or finds no listener
    report["supervisor_exited"] = until(lambda: sup.poll() is not None, 15)
    try:
        report["tick_after_stop"] = ask({"op": "tick", "kind": "loop"}) == {"ok": False, "code": "stopped"}
    except OSError:
        report["tick_after_stop"] = True
    leaked = False
    for base, _dirs, files in os.walk(state):
        for name in files:
            with open(os.path.join(base, name), "rb") as f:
                leaked = leaked or canary.encode() in f.read()
    report["token_in_state_files"] = leaked
finally:
    try:
        os.killpg(sup.pid, 9)
    except OSError:
        pass
print("DRY_REPORT " + json.dumps(report))
