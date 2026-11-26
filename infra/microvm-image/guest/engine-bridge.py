#!/usr/bin/python3
"""fx-engine-bridge: starts the engine session's supervisor in the guest and carries the host's channel to it (D#845 ON-13b1). Standard library only.

The supervisor (`fx-engine-supervisor.mjs`, a bundle of the runner's own `engineHost/supervisor.ts` and its channel, run by the image's node) is a node program,
and node has no vsock. This program listens on vsock port 5255 and copies each connection, byte for byte, to the supervisor's unix socket. It reads, parses and
decides nothing: the channel's frames, its closed list of operations and every refusal are the supervisor's. Only the host (CID 2) is served; a connection from a guest
process over the vsock loopback is closed without a reply (hygiene, as in agent.py: the guest user has sudo, so the boundary is the VM). `--unix <path>` listens on a unix
socket instead, for tests on a machine without vsock.

It starts the supervisor as the guest's unprivileged user (uid 1000), in a session of its own, with the writable state directory below /vercel/sandbox (the root disk is
read-only). When the supervisor ends, this program kills what is left of its session and ends too, and the init loop that started it starts both again a second later: a
restarted supervisor has no credential and no host, so the next channel start is a new one. The guest has no other way for the channel to reach the host: no network.
"""
import os
import signal
import socket
import subprocess
import sys
import threading

PORT = 5255
HOST_CID = 2
CHUNK = 64 << 10
MAX_CONNECTIONS = 8
CONNECT_S = 5
SOCK_DIR = os.environ.get("FX_ENGINE_SOCK_DIR", "/run/fx-engine")  # the variables exist for tests
SOCK = os.path.join(SOCK_DIR, "channel.sock")
STATE_DIR = os.environ.get("FX_ENGINE_DIR", "/vercel/sandbox/.fx-engine")
SUPERVISOR = [os.environ.get("FX_ENGINE_NODE", "/opt/fx/bin/node"), os.environ.get("FX_ENGINE_ENTRY", "/usr/lib/fx/fx-engine-supervisor.mjs")]
USER = int(os.environ.get("FX_ENGINE_UID", "1000"))
ENV = {"PATH": "/opt/fx/bin:/usr/local/bin:/usr/bin:/bin", "HOME": "/vercel", "LANG": "C.UTF-8", "FX_ENGINE_DIR": STATE_DIR, "FX_ENGINE_SOCK": SOCK}
SLOTS = threading.BoundedSemaphore(MAX_CONNECTIONS)


def pump(src, dst):
    try:
        while True:
            data = src.recv(CHUNK)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    try:
        dst.shutdown(socket.SHUT_WR)
    except OSError:
        pass


def serve(conn):
    """One host connection: to the supervisor's socket, bytes both ways, until both sides end. A supervisor that does not answer closes the host's side."""
    try:
        up = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        up.settimeout(CONNECT_S)
        up.connect(SOCK)
        up.settimeout(None)
    except OSError:
        conn.close()
        SLOTS.release()
        return
    back = threading.Thread(target=pump, args=(up, conn), daemon=True)
    back.start()
    pump(conn, up)
    back.join()
    conn.close()
    up.close()
    SLOTS.release()


def listen(unix_path):
    if unix_path is not None:
        if os.path.exists(unix_path):
            os.unlink(unix_path)
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(unix_path)
    else:
        s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        s.bind((socket.VMADDR_CID_ANY, PORT))
    s.listen(8)
    s.settimeout(1.0)
    return s


def main(argv):
    unix_path = argv[2] if len(argv) == 3 and argv[1] == "--unix" else None
    if unix_path is None and len(argv) != 1:
        return 2
    os.makedirs(SOCK_DIR, mode=0o700, exist_ok=True)
    drop = {} if USER == os.getuid() else {"user": USER, "group": USER, "extra_groups": []}
    if drop:
        os.chown(SOCK_DIR, USER, USER)
        os.makedirs(os.path.dirname(STATE_DIR), exist_ok=True)
    child = subprocess.Popen(SUPERVISOR, env=ENV, stdin=subprocess.DEVNULL, start_new_session=True, **drop)
    listener = listen(unix_path)
    try:
        while child.poll() is None:
            try:
                conn, _ = listener.accept()
            except socket.timeout:
                continue
            if unix_path is None and conn.getpeername()[0] != HOST_CID or not SLOTS.acquire(blocking=False):
                conn.close()
                continue
            threading.Thread(target=serve, args=(conn,), daemon=True).start()
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except OSError:
            pass
        child.wait()
    return 1


sys.exit(main(sys.argv))
