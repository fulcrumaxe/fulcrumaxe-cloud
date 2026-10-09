#!/usr/bin/env python3
"""Measurement helpers for scripts/spike/macos-vm-spike.sh (a measurement tool, not product code).

Every number goes into <out>/results.jsonl as one row: id, value, unit, the exact command, the
`vm.loadavg` reading taken when the row was written, and a note. Python 3 standard library only.

  rec     OUT ID VALUE UNIT COMMAND [NOTE]      write one row (COMMAND "" = an observation without a command)
  timed   OUT ID TIMEOUT_S -- CMD...            run once, log to OUT/logs/ID.log; rows ID.wall_s and ID.exit
  timeit  OUT ID N -- CMD...                    run N times; rows ID.median_ms (min/mean/max in the note)
  vmboot  OUT ID RUNS VFKIT KERNEL INITRD       boot a guest under vfkit RUNS times; exit 3 if the VM never starts
"""
import json
import os
import re
import signal
import statistics
import subprocess
import sys
import time


def load():
    r = subprocess.run(["sysctl", "-n", "vm.loadavg"], capture_output=True, text=True)
    return r.stdout.strip()


def rec(out, rid, value, unit, command, note=""):
    row = {
        "id": rid,
        "value": value,
        "unit": unit,
        "command": command,
        "load": load(),
        "note": note,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(os.path.join(out, "results.jsonl"), "a") as f:
        f.write(json.dumps(row) + "\n")


def logs_dir(out):
    d = os.path.join(out, "logs")
    os.makedirs(d, exist_ok=True)
    return d


def split_cmd(args):
    i = args.index("--")
    return args[:i], args[i + 1 :]


def run_once(cmd, timeout, logfile=None):
    """Returns (exit code or 'timeout', wall seconds). Output goes to logfile or is discarded."""
    sink = open(logfile, "wb") if logfile else subprocess.DEVNULL
    t0 = time.monotonic()
    try:
        p = subprocess.Popen(cmd, stdout=sink, stderr=subprocess.STDOUT, start_new_session=True)
    except OSError as e:
        return "cannot start: %s" % e, 0.0
    try:
        rc = p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        p.wait()
        rc = "timeout"
    wall = time.monotonic() - t0
    if logfile:
        sink.close()
    return rc, wall


def cmd_timed(a):
    out, rid, timeout = a[0], a[1], float(a[2])
    _, cmd = split_cmd(a)
    rc, wall = run_once(cmd, timeout, os.path.join(logs_dir(out), rid + ".log"))
    text = " ".join(cmd)
    rec(out, rid + ".wall_s", round(wall, 3), "s", text, "single run")
    rec(out, rid + ".exit", rc, "exit code", text, "")


def cmd_timeit(a):
    out, rid, n = a[0], a[1], int(a[2])
    _, cmd = split_cmd(a)
    samples, codes = [], set()
    for _ in range(n):
        rc, wall = run_once(cmd, 60)
        samples.append(wall * 1000)
        codes.add(str(rc))
    note = "N=%d min=%.1f mean=%.1f max=%.1f ms; exit codes seen: %s" % (
        n, min(samples), statistics.mean(samples), max(samples), ",".join(sorted(codes)))
    rec(out, rid + ".median_ms", round(statistics.median(samples), 1), "ms", " ".join(cmd), note)


def tail(path, n=12):
    try:
        with open(path, errors="replace") as f:
            lines = [l.rstrip() for l in f if l.strip()]
    except OSError:
        return ""
    return "\n".join(lines[-n:])


def cmd_vmboot(a):
    out, rid, runs, vfkit, kernel, initrd = a[0], a[1], int(a[2]), a[3], a[4], a[5]
    ld = logs_dir(out)
    times = []
    for n in range(1, runs + 1):
        console = os.path.join(ld, "%s.run%d.console" % (rid, n))
        errf = os.path.join(ld, "%s.run%d.vfkit.log" % (rid, n))
        open(console, "w").close()
        cmd = [
            vfkit, "--cpus", "2", "--memory", "1024",
            "--bootloader", 'linux,kernel=%s,initrd=%s,cmdline="console=hvc0 panic=-1"' % (kernel, initrd),
            "--device", "virtio-serial,logFilePath=" + console,
        ]
        text = " ".join(cmd)
        with open(errf, "wb") as ef:
            t0 = time.monotonic()
            try:
                p = subprocess.Popen(cmd, stdout=ef, stderr=subprocess.STDOUT, start_new_session=True)
            except OSError as e:
                rec(out, rid + ".error", str(e), "text", text, "vfkit could not be started")
                return 3
            first = None
            while time.monotonic() - t0 < 90:
                if os.path.getsize(console) > 0:
                    first = time.monotonic() - t0
                    break
                if p.poll() is not None:
                    break
                time.sleep(0.01)
            rss = None
            if first is not None:
                time.sleep(3)
                r = subprocess.run(["ps", "-o", "rss=", "-p", str(p.pid)], capture_output=True, text=True)
                rss = r.stdout.strip() or None
            code = p.poll()
            if code is None:
                os.killpg(p.pid, signal.SIGTERM)
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(p.pid, signal.SIGKILL)
                    p.wait()
        if first is None:
            err = tail(errf) or "(vfkit wrote nothing)"
            rec(out, rid + ".error", err, "text", text,
                "no guest console output; vfkit exit code %s" % code)
            return 3
        times.append(first * 1000)
        rec(out, "%s.run%d.first_console_ms" % (rid, n), round(first * 1000), "ms", text, "process start to first console byte")
        if rss:
            rec(out, "%s.run%d.host_rss_kib" % (rid, n), int(rss), "KiB", "ps -o rss= -p <vfkit pid>", "3 s after the first console byte")
        m = re.search(r"Memory: \S+/(\S+) available", open(console, errors="replace").read())
        if m:
            rec(out, "%s.run%d.guest_memory_line" % (rid, n), m.group(0), "text", "grep 'Memory:' " + console, "kernel boot line, not /proc/meminfo")
    rec(out, rid + ".median_first_console_ms", round(statistics.median(times)), "ms", "median of %d runs of the vfkit command above" % runs, "")
    return 0


def main():
    sub, a = sys.argv[1], sys.argv[2:]
    if sub == "rec":
        rec(a[0], a[1], a[2], a[3], a[4], a[5] if len(a) > 5 else "")
    elif sub == "timed":
        cmd_timed(a)
    elif sub == "timeit":
        cmd_timeit(a)
    elif sub == "vmboot":
        sys.exit(cmd_vmboot(a))
    else:
        sys.exit("unknown subcommand " + sub)


if __name__ == "__main__":
    main()
