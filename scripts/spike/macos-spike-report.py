#!/usr/bin/env python3
"""Turn the artifacts of macos-vm-spike.yml into the report section for the PR or Discussion.

  gh run download RUN_ID --repo OWNER/REPO --dir spike-artifacts
  python3 scripts/spike/macos-spike-report.py spike-artifacts/macos-vm-spike-*   # one directory per job

The workflow runs the same code to fill its job summary. Every number is printed with its exact command and
the vm.loadavg reading taken when it was written; rows without a command go under "Unreproduced observations".
The recommendation line is left for the person posting the report: it is a judgment, not a measurement.
"""
import json
import os
import sys


def rows_of(d):
    path = os.path.join(d, "results.jsonl")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


def cell(s):
    s = str(s).replace("\n", " / ").replace("|", "\\|").replace("`", "'")
    return s if len(s) <= 400 else s[:400] + " ..."


def table(rows):
    out = ["| id | value | unit | command | load | note |", "|---|---|---|---|---|---|"]
    for r in rows:
        out.append("| %s | %s | %s | `%s` | %s | %s |" % (
            r["id"], cell(r["value"]), r["unit"], cell(r["command"]), cell(r["load"]), cell(r["note"])))
    return "\n".join(out)


def val(rows, rid):
    for r in rows:
        if r["id"] == rid:
            return r["value"]
    return None


def section(name, rows):
    if not rows:
        return "## %s\n\nNo results.jsonl in this directory: the job did not reach the script (see the run log).\n" % name
    booted = val(rows, "result.vm_booted")
    failed_dl = [r for r in rows if r["id"].startswith("download.")]
    if booted == "yes":
        verdict = "YES, a guest wrote console output"
    elif failed_dl or booted == "not_tested":
        verdict = "NOT TESTED (download/checksum failed)"
    else:
        verdict = "NO, no guest console output"
    if verdict.startswith("NOT TESTED"):
        parts_nt = ["No boot was tried, so this is not a finding about the runner. The run exited non-zero. Failed downloads:", ""]
        parts_nt += ["- %s: %s (%s)" % (r["id"], cell(r["value"]), cell(r["note"])) for r in failed_dl] or ["- (no download row recorded)"]
    else:
        parts_nt = []
    err = next((r for r in rows if r["id"] == "vm.boot.error"), None)
    parts = ["## %s" % name, ""]
    parts += ["### Step 1: can a vz VM boot here?", "", "**%s.**" % verdict, ""]
    parts += parts_nt + ([""] if parts_nt else [])
    hv = val(rows, "host.hv_vmm_present")
    if hv is not None:
        parts += ["`kern.hv_vmm_present` = %s (1 means this runner is itself a VM, so any guest here is nested)." % hv, ""]
    if err:
        parts += ["Exact error (`%s`):" % cell(err["command"]), "", "```", str(err["value"]), "```", ""]
    probe = val(rows, "probe.vz_framework.output")
    if probe:
        parts += ["Framework probe:", "", "```", str(probe), "```", ""]
    host = [r for r in rows if r["id"].startswith(("host.", "pin.", "download.", "probe.vz"))]
    parts += ["### Host and pins", "", table(host), ""]
    if booted == "yes":
        parts += ["### Step 2a: VM measurements (nested if hv_vmm_present is 1; not bare-metal Mac numbers)", "",
                  table([r for r in rows if r["id"].startswith(("vm.", "result.vm", "result.nested"))]), ""]
    else:
        sb = [r for r in rows if r["id"].startswith(("seatbelt.", "probe.", "check.", "result.needs"))
              and not r["id"].startswith("probe.vz")]
        parts += ["### Step 2b: Seatbelt (sandbox-exec) fallback", "",
                  "The profile denies writes except to the workspace and the work dir, plus the device directory, "
                  "/private/tmp and /private/var/folders (temp and device paths, broader than the workspace alone), "
                  "so a write probe that lands there is allowed by design.", ""]
        for kind in ("true", "node"):
            b, s = val(rows, "seatbelt.%s_bare.median_ms" % kind), val(rows, "seatbelt.%s_sandboxed.median_ms" % kind)
            if b is not None and s is not None:
                parts.append("- Start-up overhead for `%s`: median %s ms bare, %s ms sandboxed (difference %.1f ms)." % (
                    kind, b, s, float(s) - float(b)))
        for arm in ("unsandboxed", "sandboxed"):
            w = [val(rows, "check.%s.run%d.wall_s" % (arm, i)) for i in (1, 2)]
            e = [val(rows, "check.%s.run%d.exit" % (arm, i)) for i in (1, 2)]
            if any(x is not None for x in w):
                parts.append("- Scoped check.sh, %s: wall %s s, exit codes %s." % (arm, w, e))
        parts += ["", table(sb), ""]
    unrep = [r for r in rows if not r["command"]]
    parts += ["### Unreproduced observations", ""]
    parts += ["- %s: %s (%s)" % (r["id"], cell(r["value"]), cell(r["note"])) for r in unrep] or ["(none)"]
    return "\n".join(parts) + "\n"


def main():
    dirs = sys.argv[1:]
    if not dirs:
        sys.exit(__doc__)
    print("# B-0-mac report: macOS sandbox spike on free GitHub-hosted runners\n")
    for d in dirs:
        print(section(os.path.basename(os.path.normpath(d)), rows_of(d)))
    print("## Recommendation (fill in)\n\nOne of: a macOS `vz` engine child / Mac hardware needed (M3 or newer, macOS 15 or later) / "
          "Seatbelt stays as the macOS sandbox. State which, and which rows above support it.\n")


if __name__ == "__main__":
    main()
