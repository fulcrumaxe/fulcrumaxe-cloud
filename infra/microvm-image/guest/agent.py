#!/usr/bin/python3
"""fx-agent: the in-guest agent of the microVM engine (D#587 B-1). Standard library only.

It listens on one vsock port and serves one request per connection: ping, exec, put, get, counters. Only the host (vsock
CID 2) is served: a connection from a guest process to this port (over the vsock loopback) is closed without a reply. That
check is hygiene, not a security boundary: the image gives the `ubuntu` user passwordless sudo, so code running in the guest
is effectively root in the guest and can do anything this agent can. The boundary is the VM itself plus the read-only root
drive. Nothing here opens a network socket. `--unix <path>` listens on a Unix socket instead, for tests on a machine without
vsock; it is the same code path after accept.

Frame: 4-byte big-endian length, then that many bytes of JSON. Some requests and replies carry raw bytes after the JSON; the
JSON names their length (`size`, `stdin_size`, `stdout_size`, `stderr_size`).
"""
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

PORT = 5252
VERSION = 1
HOST_CID = 2
MAX_HEADER = 1 << 20
MAX_BYTES = 256 << 20
MAX_OUTPUT = 16 << 20
USER = ("ubuntu", 1000, 1000)
BASE_ENV = {"PATH": "/opt/fx/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/vercel", "LANG": "C.UTF-8"}
STATS = {"requests": 0, "exec": 0, "bytes_in": 0, "bytes_out": 0}
LOCK = threading.Lock()


def read_exact(conn, n):
    chunks = []
    while n > 0:
        chunk = conn.recv(min(n, 1 << 20))
        if not chunk:
            raise EOFError
        chunks.append(chunk)
        n -= len(chunk)
    return b"".join(chunks)


def read_header(conn):
    """Read one length-prefixed JSON header. The declared length is checked against MAX_HEADER before a single byte of the
    body is read, so a peer cannot make the agent buffer up to 4 GiB."""
    (n,) = struct.unpack(">I", read_exact(conn, 4))
    if n > MAX_HEADER:
        raise ValueError("header too large")
    return json.loads(read_exact(conn, n))


def send(conn, header, *blobs):
    body = json.dumps(header, separators=(",", ":")).encode()
    conn.sendall(struct.pack(">I", len(body)) + body)
    for blob in blobs:
        conn.sendall(blob)
    with LOCK:
        STATS["bytes_out"] += sum(len(b) for b in blobs)


def read_proc(path):
    with open(path) as f:
        return f.read()


def counters():
    mem = {}
    for line in read_proc("/proc/meminfo").splitlines():
        key, _, rest = line.partition(":")
        if key in ("MemTotal", "MemAvailable", "SwapTotal"):
            mem[key] = int(rest.split()[0])
    nics = sorted(n for n in os.listdir("/sys/class/net"))
    return {"uptime_s": float(read_proc("/proc/uptime").split()[0]), "loadavg": read_proc("/proc/loadavg").split()[:3], "mem_kb": mem,
            "cpu_ticks": [int(x) for x in read_proc("/proc/stat").splitlines()[0].split()[1:]], "nics": nics, "agent": dict(STATS)}


def run_exec(req, stdin):
    argv = req["argv"]
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        raise ValueError("argv must be a non-empty list of strings")
    env = dict(BASE_ENV)
    env.update({k: v for k, v in (req.get("env") or {}).items() if isinstance(k, str) and isinstance(v, str)})
    drop = req.get("user") != "root" and os.geteuid() == 0
    kwargs = {"user": USER[1], "group": USER[2], "extra_groups": []} if drop else {}
    cwd = req.get("cwd") or (BASE_ENV["HOME"] if os.path.isdir(BASE_ENV["HOME"]) else "/")
    timeout = float(req.get("timeout_s") or 600)
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=cwd,
                                start_new_session=True, **kwargs)
    except OSError as err:
        return {"ok": True, "exit": 127, "error": err.strerror}, b"", b""
    out, err = bytearray(), bytearray()
    seen = {"stdout": 0, "stderr": 0}

    def drain(stream, buf, name):
        # keep at most MAX_OUTPUT bytes; read and drop the rest so the child never blocks on a full pipe
        while True:
            chunk = stream.read1(65536)
            if not chunk:
                return
            seen[name] += len(chunk)
            room = MAX_OUTPUT - len(buf)
            if room > 0:
                buf += chunk[:room]

    def feed():
        try:
            proc.stdin.write(stdin)
        except OSError:
            pass
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass

    threads = [threading.Thread(target=drain, args=(proc.stdout, out, "stdout"), daemon=True),
               threading.Thread(target=drain, args=(proc.stderr, err, "stderr"), daemon=True),
               threading.Thread(target=feed, daemon=True)]
    for t in threads:
        t.start()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_group(proc)
        for t in threads:
            t.join(5)
        return {"ok": True, "exit": None, "timed_out": True}, b"", b""
    for t in threads:
        t.join(5)
    code = proc.returncode
    return {"ok": True, "exit": code if code >= 0 else None, "signal": -code if code < 0 else None, "stdout_size": len(out), "stderr_size": len(err),
            "truncated": seen["stdout"] > MAX_OUTPUT or seen["stderr"] > MAX_OUTPUT}, bytes(out), bytes(err)


def kill_group(proc):
    """The child leads its own session, so its whole process group (grandchildren that hold the output pipes included) dies with it."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        proc.kill()
    proc.wait()


def put(req, data):
    path = req["path"]
    if not path.startswith("/"):
        raise ValueError("path must be absolute")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.fx-tmp-{os.getpid()}-{threading.get_ident()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, int(req.get("mode", 0o644)) & 0o777)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    if req.get("user") != "root" and os.geteuid() == 0:
        os.chown(tmp, USER[1], USER[2])
    os.replace(tmp, path)
    return {"ok": True}


def serve(conn):
    try:
        header = read_header(conn)
        op = header.get("op")
        size = header.get("size", header.get("stdin_size", 0))
        if not isinstance(size, int) or not 0 <= size <= MAX_BYTES:
            raise ValueError("bad size")
        body = read_exact(conn, size) if size else b""
        with LOCK:
            STATS["requests"] += 1
            STATS["bytes_in"] += size
        if op == "ping":
            send(conn, {"ok": True, "proto": VERSION})
        elif op == "counters":
            send(conn, {"ok": True, **counters()})
        elif op == "exec":
            with LOCK:
                STATS["exec"] += 1
            reply, out, err = run_exec(header, body)
            send(conn, reply, out, err)
        elif op == "put":
            send(conn, put(header, body))
        elif op == "get":
            with open(header["path"], "rb") as f:
                if os.fstat(f.fileno()).st_size > MAX_BYTES:
                    raise ValueError("file too large")
                data = f.read()
            send(conn, {"ok": True, "size": len(data)}, data)
        else:
            send(conn, {"ok": False, "error": "unknown op"})
    except EOFError:
        pass
    except (OSError, ValueError, KeyError, TypeError, AttributeError, json.JSONDecodeError) as err:
        try:
            send(conn, {"ok": False, "error": f"{type(err).__name__}: {err}"[:200]})
        except OSError:
            pass
    finally:
        close_after_flush(conn)


def close_after_flush(conn):
    """A vsock close can drop bytes still queued for the host, so end our side and wait for the host to end its own."""
    try:
        conn.shutdown(socket.SHUT_WR)
        conn.settimeout(30)
        while conn.recv(65536):
            pass
    except OSError:
        pass
    conn.close()


def listen(unix_path):
    if unix_path:
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(unix_path)
    else:
        srv = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        srv.bind((socket.VMADDR_CID_ANY, PORT))
    srv.listen(64)
    return srv


def main():
    unix_path = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == "--unix" else None
    srv = listen(unix_path)
    print(f"FXMARK agent_listening uptime={read_proc('/proc/uptime').split()[0]} t={time.time():.0f}", flush=True)
    while True:
        conn, peer = srv.accept()
        if unix_path is None and peer[0] != HOST_CID:
            conn.close()
            continue
        threading.Thread(target=serve, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
