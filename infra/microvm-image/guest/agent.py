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

Streaming (B-1b), advertised by `caps` in the ping reply (`exec_stream`, `kill`); the proto number stays 1, so an older daemon is
unaffected. `exec_stream` takes the exec fields plus `id` (1-64 of A-Za-z0-9_-, chosen by the caller, unique per agent run) and
`stdin_size`. It answers with a sequence of frames, each JSON with `seq` counting up from 0: `{"ev":"data","stream":"stdout"|"stderr",
"seq":n,"size":k}` then k raw bytes (k is 1..CHUNK), and finally exactly one `{"ev":"exit","seq":n,"exit":int|null,"signal":int|null,
"timed_out":bool}`, after which the agent closes. Frames follow the order the bytes reached the agent: exact within a stream, and
across streams exact only up to what one select() round can tell apart. The agent reads a pipe only after the previous frame has
been sent, so a slow host stalls the child on its full pipe and the agent holds at most CHUNK bytes per command. A send that fails
or stalls for STALL_S (a host that vanished or stopped reading) kills the command. After the leader exits the stream ends
within POST_EXIT_S whatever output still arrives, and the command's remaining processes are killed first. "Killed" and `kill`
reach the process group and also every process that inherited the command's marker variable (`FX_CMD_ID=<agent pid>.<id>`, set last in its
environment), which finds descendants that left the group with setsid. A process that clears its environment escapes this; the guest
is root-equivalent to the code it runs, so this is cleanup, not a boundary. A client treats any frame other than `data` or `exit`
as fatal. `kill` takes `id` and `signal` (SIGTERM default,
SIGKILL, SIGINT, SIGHUP) and answers `{"ok":true,"signalled":true}` for a running command (its exit comes on the stream),
`{"ok":true,"signalled":false,"exit":..,"signal":..,"timed_out":..}` with the recorded result for one that already ended, and
`{"ok":false,"code":"unknown_id"|"bad_id"|"bad_signal"}` otherwise. Errors before the first frame are the usual `{"ok":false,
"error":..}`; an id already in use answers `code: duplicate_id`.

The subscription token (D#587 B-6.4), advertised as cap `token`. The host pushes it with `token_put` (`size` 1..4096 raw bytes of printable
ASCII; no JSON field carries it) into SECRET_DIR, a 0700 tmpfs that init mounts; the agent refuses to write into a directory that is not a
real 0700 directory of its own on tmpfs. The bytes go from the socket into one preallocated buffer, to a 0600 file, and are zeroed there:
the agent never builds an immutable object from them, so its heap keeps no copy. `exec` and `exec_stream` take `"token": true`: the agent
makes a cgroup of its own for the launch (cgroup2, under CGROUP_DIR; no cgroup2 means a refusal that consumes nothing), opens the file,
unlinks its name and hands the open fd to a launcher that joins the cgroup before it can fork, drops to the command's user, reads the fd and
execs the command with the token variable in its environment (one launch per delivery). A request that names that variable in `env` is
refused. `token_wipe` (asked before any snapshot) zeroes and removes the file, writes `cgroup.kill` in every token cgroup (so a descendant
is killed whatever it did with its name, session or environment) and answers ok only when each cgroup is empty; the environment is also
checked by name as a second net. /proc/<pid>/environ is only ever read into one preallocated buffer that is zeroed after each pid. A copy a
holder makes on purpose (a file, the network) is outside what the wipe can undo. No reply, error or log line carries the token or a byte of it.
"""
import itertools
import json
import os
import re
import select
import signal
import socket
import stat
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
CHUNK = 64 << 10
STALL_S = float(os.environ.get("FX_AGENT_STALL_S", "60"))  # the variable exists for tests
GRACE_BYTES = 1 << 20
POST_EXIT_S = 5
MARK = "FX_CMD_ID"
KEEP_DONE = 256
CAPS = ["exec_stream", "kill", "token"]
SECRET_DIR = os.environ.get("FX_SECRET_DIR", "/run/fx-secret")  # the variable exists for tests; init mounts the default as a 0700 tmpfs
TOKEN_FILE = "oauth-token"
TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN"
MAX_TOKEN = 4096
RECV = bytearray(MAX_TOKEN)  # the only place a pushed token ever sits in this process; zeroed after every put
RECV_LOCK = threading.Lock()
ENV_BUF = bytearray(1 << 16)  # the only place another process's environment is ever read into; zeroed after each pid
ENV_LOCK = threading.Lock()
CGROUP_DIR = os.environ.get("FX_CGROUP_DIR", "/sys/fs/cgroup/fx-token")  # the variable exists for tests; init mounts cgroup2 at /sys/fs/cgroup
CG_SEQ = itertools.count(1)
# Runs as the agent's user: joins its own cgroup BEFORE it can fork anything, then drops to the command's user (or stays, when uid is "-"),
# reads the token from the inherited fd and execs the command with it in the environment; the launcher itself is replaced by the command.
LAUNCHER = ("import os,sys\n"
            "fd,name,procs,uid,gid,argv=int(sys.argv[1]),sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5],sys.argv[6:]\n"
            "try:\n"
            "    with open(procs,'w') as f: f.write(str(os.getpid()))\n"
            "    if uid!='-': os.setgroups([]); os.setgid(int(gid)); os.setuid(int(uid))\n"
            "except OSError: os._exit(126)\n"
            "b=bytearray()\n"
            "while True:\n"
            "    c=os.read(fd,4096)\n"
            "    if not c: break\n"
            "    b+=c\n"
            "os.close(fd)\n"
            "env=dict(os.environ); env[name]=b.decode('ascii')\n"
            "try: os.execvpe(argv[0],argv,env)\n"
            "except OSError: os._exit(127)\n")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SIGNALS = {"SIGTERM": signal.SIGTERM, "SIGKILL": signal.SIGKILL, "SIGINT": signal.SIGINT, "SIGHUP": signal.SIGHUP}
COMMANDS = {}  # id -> {"proc", "pending" (a signal asked for before the process existed), "result"}; insertion order = age
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


def mount_type(path):
    """The file system type of the mount that holds `path`, from /proc/self/mountinfo (the longest mount point that is a prefix)."""
    best, kind = -1, None
    with open("/proc/self/mountinfo") as f:
        for line in f:
            left, _, right = line.partition(" - ")
            fields = left.split()
            if len(fields) < 5 or not right:
                continue
            point = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), fields[4])
            if (point == "/" or path == point or path.startswith(point + "/")) and len(point) > best:
                best, kind = len(point), right.split()[0]
    return kind


def secret_dir_problem():
    """None when the secret directory is a real directory of ours, mode 0700, on its own tmpfs; else a fixed code."""
    try:
        st = os.lstat(SECRET_DIR)
    except OSError:
        return "secret_dir_missing"
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o700:
        return "secret_dir_unsafe"
    try:
        if mount_type(os.path.realpath(SECRET_DIR)) != "tmpfs":
            return "secret_dir_not_tmpfs"
    except OSError:
        return "secret_dir_unsafe"
    return None


def token_path():
    return os.path.join(SECRET_DIR, TOKEN_FILE)


def token_put(conn, size):
    """Receives the token straight into one preallocated buffer, writes it to a 0600 file and zeroes the buffer. The file is
    removed on every failure after it exists. The reply never echoes input."""
    if not isinstance(size, int) or not 1 <= size <= MAX_TOKEN:
        return {"ok": False, "code": "bad_token"}
    problem = secret_dir_problem()
    if problem:
        return {"ok": False, "code": problem}
    if not RECV_LOCK.acquire(timeout=10):
        return {"ok": False, "code": "busy"}
    view = memoryview(RECV)[:size]  # one buffer for the life of the agent, so zeroing it is the whole story (a freed block's fate is the allocator's)
    fd = None
    try:
        got = 0
        while got < size:
            n = conn.recv_into(view[got:], size - got)
            if n == 0:
                raise EOFError
            got += n
        if any(b < 0x21 or b > 0x7E for b in view):
            return {"ok": False, "code": "bad_token"}
        try:
            os.unlink(token_path())
        except FileNotFoundError:
            pass
        fd = os.open(token_path(), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        os.fchmod(fd, 0o600)
        done = 0
        while done < size:
            done += os.write(fd, view[done:])
        os.close(fd)
        fd = None
        return {"ok": True}
    except BaseException:
        if fd is not None:
            os.close(fd)
            try:
                os.unlink(token_path())
            except OSError:
                pass
        raise
    finally:
        view[:] = bytes(size)
        view.release()
        RECV_LOCK.release()


def take_token():
    """The token file as an open fd whose name is already gone: a second launch finds nothing."""
    problem = secret_dir_problem()
    if problem:
        raise ValueError(problem)
    try:
        fd = os.open(token_path(), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise ValueError("no_token") from None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.geteuid():
            raise ValueError("no_token")
        os.unlink(token_path())
    except BaseException:
        os.close(fd)
        raise
    return fd


def popen(argv, kwargs, token):
    """Popen with the three pipes; with `token`, the command runs behind the launcher and the token reaches it only as an inherited fd."""
    pipes = dict(stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if not token:
        return subprocess.Popen(argv, **pipes, **kwargs)
    cg = cgroup_new()  # before the token is taken: a refusal here consumes nothing
    try:
        fd = take_token()
    except BaseException:
        os.rmdir(cg)
        raise
    kw = dict(kwargs)
    ids = ("-", "-")
    if "user" in kw:  # the launcher drops the user itself, once it is in its cgroup
        ids = (str(kw.pop("user")), str(kw.pop("group")))
        kw.pop("extra_groups", None)
    try:
        return subprocess.Popen([sys.executable, "-I", "-c", LAUNCHER, str(fd), TOKEN_ENV, os.path.join(cg, "cgroup.procs"), *ids, *argv], pass_fds=(fd,), **pipes, **kw)
    except BaseException:
        os.rmdir(cg)
        raise
    finally:
        os.close(fd)


def cgroup_new():
    """A fresh cgroup under the agent's own parent, for one token launch; ValueError(cgroup_unavailable) when cgroup2 cannot be used."""
    try:
        os.makedirs(CGROUP_DIR, mode=0o755, exist_ok=True)
        if mount_type(os.path.realpath(CGROUP_DIR)) != "cgroup2":
            raise OSError
        path = os.path.join(CGROUP_DIR, f"t{os.getpid()}-{next(CG_SEQ)}")
        os.mkdir(path, 0o755)
    except OSError:
        raise ValueError("cgroup_unavailable") from None
    if not os.path.exists(os.path.join(path, "cgroup.kill")):
        os.rmdir(path)
        raise ValueError("cgroup_unavailable")
    return path


def environ_has(pid, want):
    """True when an entry of /proc/<pid>/environ starts with `want` (bytes). The file is read with a plain fd into ENV_BUF, one buffer for the
    life of the agent, searched in place and zeroed before returning: no immutable copy of any process's environment ever exists here."""
    with ENV_LOCK:
        view = memoryview(ENV_BUF)
        try:
            fd = os.open(f"/proc/{pid}/environ", os.O_RDONLY | os.O_CLOEXEC)
        except OSError:
            view.release()
            return False
        n = 1  # ENV_BUF[0] is a NUL, so an entry at the very start is found like any other
        try:
            ENV_BUF[0] = 0
            while n < len(ENV_BUF) - 1:
                got = os.readv(fd, [view[n:len(ENV_BUF) - 1]])
                if got == 0:
                    break
                n += got
            ENV_BUF[n] = 0
            return ENV_BUF.find(b"\0" + want, 0, n + 1) != -1
        except OSError:
            return False  # gone, or not ours to read
        finally:
            os.close(fd)
            view[:n + 1] = bytes(n + 1)
            view.release()


def token_holders():
    """Pids (other than ours) whose environment names the token variable (a second check; the cgroups are the first)."""
    found = []
    for name in os.listdir("/proc"):
        if name.isdigit() and int(name) != os.getpid() and environ_has(int(name), f"{TOKEN_ENV}=".encode()):
            found.append(int(name))
    return found


def cgroup_kill_all():
    """Kills every process of every token cgroup (`cgroup.kill`: by descent, whatever name or session a descendant took), waits until each is
    empty, removes them. Returns (processes that were there, True when all are now empty)."""
    try:
        paths = [p for p in (os.path.join(CGROUP_DIR, n) for n in os.listdir(CGROUP_DIR)) if os.path.isdir(p)]
    except FileNotFoundError:
        return 0, True  # no token launch ever happened
    except OSError:
        return 0, False
    killed, ok = 0, True
    for p in paths:
        try:
            with open(os.path.join(p, "cgroup.procs")) as f:
                killed += len(f.read().split())
            with open(os.path.join(p, "cgroup.kill"), "w") as f:
                f.write("1")
        except OSError:
            ok = False
    until = time.monotonic() + 5
    for p in paths:
        while True:
            try:
                with open(os.path.join(p, "cgroup.procs")) as f:
                    empty = f.read().strip() == ""
            except OSError:
                empty = False
            if empty or time.monotonic() >= until:
                break
            time.sleep(0.02)
        if not empty:
            ok = False
            continue
        try:
            os.rmdir(p)
        except OSError:
            ok = False
    return killed, ok


def alive(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rpartition(")")[2].split()[0] != "Z"  # a zombie holds no memory
    except OSError:
        return False


def token_wipe():
    """Before a snapshot: zero and remove the token file, kill every process that holds the token, and say ok only when none is left."""
    removed = False
    problem = secret_dir_problem()
    if problem in ("secret_dir_unsafe", "secret_dir_not_tmpfs"):
        return {"ok": False, "code": problem}
    if problem is None:
        try:
            fd = os.open(token_path(), os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except FileNotFoundError:
            fd = None
        if fd is not None:
            try:
                os.write(fd, bytes(os.fstat(fd).st_size))
            finally:
                os.close(fd)
            os.unlink(token_path())
            removed = True
    killed, emptied = cgroup_kill_all()
    # a second check, by name, for anything that is not in a token cgroup
    found = token_holders()
    for pid in found:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    until = time.monotonic() + 5
    while any(alive(p) for p in found) and time.monotonic() < until:
        time.sleep(0.05)
    if not emptied or any(alive(p) for p in found) or token_holders():
        return {"ok": False, "code": "holders_remain"}
    return {"ok": True, "removed": removed, "killed": killed + len(found)}


def spawn_args(req, mark=None):
    """Everything Popen could refuse is refused here, before a command is registered."""
    argv = req["argv"]
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) and "\0" not in a for a in argv):
        raise ValueError("argv must be a non-empty list of strings without NUL")
    if TOKEN_ENV in (req.get("env") or {}):
        raise ValueError("env must not name the token variable")
    if req.get("token") is True and req.get("user") == "root":  # a root descendant could leave the token cgroup, so the wipe could not find it
        raise ValueError("token_requires_unprivileged_user")
    env = dict(BASE_ENV)
    env.update({k: v for k, v in (req.get("env") or {}).items() if isinstance(k, str) and isinstance(v, str)})
    if mark is not None:
        env[MARK] = mark
    if any("\0" in k or "=" in k or not k or "\0" in v for k, v in env.items()):
        raise ValueError("env names and values must not contain NUL, and names not '='")
    drop = req.get("user") != "root" and os.geteuid() == 0
    kwargs = {"user": USER[1], "group": USER[2], "extra_groups": []} if drop else {}
    cwd = req.get("cwd") or (BASE_ENV["HOME"] if os.path.isdir(BASE_ENV["HOME"]) else "/")
    if not isinstance(cwd, str) or "\0" in cwd:
        raise ValueError("cwd must be a string without NUL")
    return argv, dict(env=env, cwd=cwd, start_new_session=True, **kwargs), float(req.get("timeout_s") or 600)


def run_exec(req, stdin):
    argv, kwargs, timeout = spawn_args(req)
    try:
        proc = popen(argv, kwargs, req.get("token") is True)
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


def ended(proc):
    """True once the child has exited, without reaping it (the pid stays ours until `finish`)."""
    return os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def marked(cid):
    """Pids (other than ours) whose environment carries this command's marker: its descendants, setsid or not."""
    want, found = f"{MARK}={os.getpid()}.{cid}\0".encode(), []
    for name in os.listdir("/proc"):
        if name.isdigit() and int(name) != os.getpid() and environ_has(int(name), want):
            found.append(int(name))
    return found


def signal_group(entry, sig):
    """Under LOCK. The group is signalled only while the leader is unreaped, so its pid cannot have been reused; the marked
    processes are signalled too, which reaches descendants that left the group."""
    if entry["result"] is None and entry["proc"] is not None:
        try:
            os.killpg(entry["proc"].pid, sig)
        except OSError:
            pass
        for pid in marked(entry["id"]):
            try:
                os.kill(pid, sig)
            except OSError:
                pass


def finish(entry, timed_out):
    with LOCK:
        code = entry["proc"].wait()
        entry["proc"].stdout.close()
        entry["proc"].stderr.close()
        entry["result"] = {"exit": code if code >= 0 else None, "signal": -code if code < 0 else None, "timed_out": timed_out}
        while sum(1 for e in COMMANDS.values() if e["result"] is not None) > KEEP_DONE:
            del COMMANDS[next(k for k, e in COMMANDS.items() if e["result"] is not None)]
    return entry["result"]


def feed_stdin(proc, data):
    try:
        proc.stdin.write(data)
    except OSError:
        pass
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass


def run_stream(conn, req, stdin):
    cid = req.get("id")
    if not isinstance(cid, str) or not ID_RE.match(cid):
        return send(conn, {"ok": False, "code": "bad_id", "error": "id must match [A-Za-z0-9_-]{1,64}"})
    argv, kwargs, timeout = spawn_args(req, f"{os.getpid()}.{cid}")
    entry = {"id": cid, "proc": None, "pending": None, "result": None}
    with LOCK:
        taken = cid in COMMANDS
        if not taken:
            COMMANDS[cid] = entry  # registered before the process exists, so a kill that arrives during start finds it
            STATS["exec"] += 1
    if taken:
        return send(conn, {"ok": False, "code": "duplicate_id", "error": "id in use"})
    try:
        proc = popen(argv, kwargs, req.get("token") is True)
    except Exception as err:
        with LOCK:
            del COMMANDS[cid]  # a failed start leaves no record: kill says unknown_id and the id can be used again
        if isinstance(err, OSError):
            return send(conn, {"ev": "exit", "seq": 0, "exit": 127, "signal": None, "timed_out": False, "error": err.strerror})
        raise
    with LOCK:
        entry["proc"] = proc
        if entry["pending"] is not None:
            signal_group(entry, entry["pending"])
    threading.Thread(target=feed_stdin, args=(proc, stdin), daemon=True).start()
    fds = {proc.stdout.fileno(): "stdout", proc.stderr.fileno(): "stderr"}
    seq, timed_out, exit_at, after = 0, False, None, 0
    deadline = time.monotonic() + timeout
    conn.settimeout(STALL_S)
    try:
        while fds or exit_at is None:
            ready = select.select(list(fds), [], [], 0.2)[0]
            for fd in ready:
                chunk = os.read(fd, CHUNK)
                if not chunk:
                    del fds[fd]
                    continue
                send(conn, {"ev": "data", "stream": fds[fd], "seq": seq, "size": len(chunk)}, chunk)  # blocks on a slow host: the backpressure
                seq += 1
                after += len(chunk) if exit_at else 0
            now = time.monotonic()
            if exit_at is None and ended(proc):
                exit_at = now
            if not timed_out and exit_at is None and now > deadline:
                timed_out = True
                with LOCK:
                    signal_group(entry, signal.SIGKILL)
            # the leader is gone but something still holds a pipe: stop after a quiet second, GRACE_BYTES more, or POST_EXIT_S
            if exit_at is not None and (after > GRACE_BYTES or now - exit_at > POST_EXIT_S or (not ready and now - exit_at > 1)):
                break
    except Exception:
        with LOCK:
            signal_group(entry, signal.SIGKILL)  # the host went away or stopped reading: nobody is left to see this command
        finish(entry, timed_out)
        raise
    with LOCK:
        signal_group(entry, signal.SIGKILL)  # whatever outlived the leader dies with the command
    result = finish(entry, timed_out)
    send(conn, {"ev": "exit", "seq": seq, **result})


def run_kill(req):
    cid, name = req.get("id"), req.get("signal", "SIGTERM")
    if not isinstance(cid, str) or not ID_RE.match(cid):
        return {"ok": False, "code": "bad_id", "error": "id must match [A-Za-z0-9_-]{1,64}"}
    if name not in SIGNALS:
        return {"ok": False, "code": "bad_signal", "error": "signal must be one of " + ", ".join(SIGNALS)}
    with LOCK:
        entry = COMMANDS.get(cid)
        if entry is None:
            return {"ok": False, "code": "unknown_id", "error": "no such command"}
        if entry["result"] is not None:
            return {"ok": True, "signalled": False, **entry["result"]}
        if entry["proc"] is None:
            if entry["pending"] != signal.SIGKILL:  # still starting: the starter signals the moment the process exists; KILL is never weakened
                entry["pending"] = SIGNALS[name]
        else:
            signal_group(entry, SIGNALS[name])
        return {"ok": True, "signalled": True}


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
        if op == "token_put":  # the body goes into a buffer of its own, never through read_exact
            with LOCK:
                STATS["requests"] += 1
            return send(conn, token_put(conn, size))
        body = read_exact(conn, size) if size else b""
        with LOCK:
            STATS["requests"] += 1
            STATS["bytes_in"] += size
        if op == "ping":
            send(conn, {"ok": True, "proto": VERSION, "caps": CAPS})
        elif op == "counters":
            send(conn, {"ok": True, **counters()})
        elif op == "exec":
            with LOCK:
                STATS["exec"] += 1
            reply, out, err = run_exec(header, body)
            send(conn, reply, out, err)
        elif op == "exec_stream":
            run_stream(conn, header, body)
        elif op == "kill":
            send(conn, run_kill(header))
        elif op == "token_wipe":
            send(conn, token_wipe())
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
