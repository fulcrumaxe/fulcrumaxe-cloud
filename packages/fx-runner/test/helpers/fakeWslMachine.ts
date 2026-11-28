import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROBE_MARKER } from "../../src/sandbox/probe.js";
import { CANARY_DIR, CMD_EXE, CMD_MARKER, WSLINFO } from "../../src/sandbox/wslGate.js";
import { fakeSandboxHost, type FakeSandboxHost } from "./fakeSandboxHost.js";
import { tempDir } from "./tempTree.js";

export const WSL2_KERNEL = "5.15.167.4-microsoft-standard-WSL2";
export const CONF_OK = "[interop]\nenabled=false\nappendWindowsPath=false\n";
export const DRIVE_MOUNT = "55 22 0:48 / /mnt/c rw,noatime - 9p C:\\134 rw,aname=drvfs";
export const ROOT_MOUNT = "26 1 8:16 / / rw,relatime - ext4 /dev/sdb rw";

/** What the pretend WSL2 machine does. Every default is a machine that is set up as the README says and should be cleared. */
export interface WslMachineOptions {
  /** Whether C:\Users can be listed outside the sandbox. */
  drive?: boolean;
  /** Whether cmd.exe is a file at its real path. */
  cmdExe?: boolean;
  /** What `readlink -f` says cmd.exe really is. */
  cmdRealPath?: string;
  /** Whether the Windows interop is live, so cmd.exe would run when it can be reached. */
  interopLive?: boolean;
  /** Whether the sandbox hides a path at all: false is a sandbox that ignores every deny (what a missing deny looks like). */
  honoursDenies?: boolean;
  /** Makes the sandboxed marker command fail. */
  wrapperBroken?: boolean;
  /** Makes the sandboxed probe scripts print nothing (a tool that never ran them). */
  silentProbes?: boolean;
  /** The drive lists as empty and exits 0 outside the sandbox (a hollow control). */
  driveEmpty?: boolean;
  /** Lists the drive but exits with this status (a partial listing with an error). */
  driveExit?: number;
  /** Makes the sandboxed probes (not the marker command) time out after printing their answer. */
  probesTimeOut?: boolean;
  /** The exit status of `wslinfo`, whatever it prints. */
  networkingExit?: number;
  /** `wslinfo` does not answer in time. */
  networkingTimesOut?: boolean;
  /** The status `ls` ends with for the canary inside the sandbox, whatever the sandbox hides (127: the shell found no `ls`). */
  canaryStatus?: number;
  /** A sandbox that stands an empty directory where the canary is: the listing works, empty, exit 0. */
  hollowCanary?: boolean;
  /** `ls` does not run at all in the sandbox (not even on `/`). */
  lsMissing?: boolean;
  /** Makes only one sandboxed probe print nothing. */
  silentOnly?: "canary" | "cmd";
  /** Makes every process start throw. */
  throws?: boolean;
  /** Makes the sandboxed probes time out. */
  timesOut?: boolean;
  /** What `wslinfo --networking-mode` prints; undefined: the command is not there. */
  networking?: string;
  mountinfo?: string;
  files?: Record<string, string>;
  /** Where each path really is (a symlink map for `realPath`). */
  links?: Record<string, string>;
}

/** A directory with a bwrap and a socat in it (empty executables): what the search path must hold for the sandbox tool to be found. */
export function toolDir(): string {
  const dir = tempDir("fx-wslgate-");
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["bwrap", "socat"]) {
    writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, name), 0o755);
  }
  return bin;
}

/**
 * A host that behaves like a WSL2 machine: a script run outside the sandbox sees the Windows drive, and a script run through bubblewrap sees it
 * unless one of the arguments hides it (`--tmpfs` over the path or a parent), which is what the real sandbox's deny list does. A deny that is
 * missing from the settings therefore changes what the probes see, which is what the mutation checks rely on.
 */
export function fakeWslMachine(options: WslMachineOptions = {}): FakeSandboxHost {
  const o = { drive: true, cmdExe: true, cmdRealPath: CMD_EXE, interopLive: false, honoursDenies: true, networking: "nat" as string | undefined, ...options };
  const base = fakeSandboxHost({ files: { "/etc/wsl.conf": CONF_OK, ...o.files }, dirs: ["/mnt", "/run/WSL", "/mnt/c", "/home/dev"], wsl: { interop: false, mountinfo: o.mountinfo ?? [ROOT_MOUNT, DRIVE_MOUNT].join("\n") } });
  const wsl = { ...base.wsl!, realPath: (target: string) => o.links?.[target] ?? target };
  const hidden = (tmpfs: string[], target: string): boolean => o.honoursDenies && tmpfs.some((dir) => target === dir || target.startsWith(`${dir}/`));
  return {
    ...base,
    wsl,
    run: async (command, args, env, timeoutMs) => {
      base.calls.push({ command, args, env, timeoutMs });
      if (o.throws) throw new Error("spawn failed");
      const ok = (stdout: string, code = 0) => ({ code, stdout, stderr: "", timedOut: false });
      if (command === "/bin/sh") {
        const script = args[1] ?? "";
        if (script.startsWith("ls -A") && o.driveEmpty) return ok("");
        if (script.startsWith("ls -A")) return o.drive ? ok("Default\ndev\n", o.driveExit ?? 0) : ok("", 2);
        if (script.startsWith("test -f")) return o.cmdExe ? ok(`${o.cmdRealPath}\n`) : ok("", 1);
        if (script.startsWith(`${WSLINFO} `)) return o.networkingTimesOut ? { code: null, stdout: "nat\n", stderr: "", timedOut: true } :  o.networking === undefined ? ok("", 127) : ok(`${o.networking}\n`, o.networkingExit ?? 0);
        return ok("");
      }
      // Through the sandbox tool: the script follows `--`, and what is hidden is every `--tmpfs` directory.
      if (o.timesOut) return { code: null, stdout: "", stderr: "", timedOut: true };
      const tmpfs = args.flatMap((arg, index) => (args[index - 1] === "--tmpfs" ? [arg] : []));
      const script = args[args.length - 1] ?? "";
      if (script.startsWith("printf %s")) return o.wrapperBroken ? { code: 1, stdout: "", stderr: "bwrap: failed", timedOut: false } : ok(PROBE_MARKER);
      if (o.silentProbes) return ok("");
      if (o.silentOnly === "canary" && script.includes(`ls -A ${CANARY_DIR}`)) return ok("");
      if (o.silentOnly === "cmd" && script.includes(CMD_MARKER)) return ok("");
      if (o.probesTimeOut) return { code: 0, stdout: "fx-exit:2", stderr: "", timedOut: true };
      if (script.includes(`ls -A ${CANARY_DIR}`)) {
        // A `ls` that fails on everything with its own "cannot access" status: only the precheck on `/` shows it is broken.
        if (o.lsMissing) return script.includes("ls -A / ") ? ok("fx-ls-broken") : ok("fx-exit:2");
        if (o.canaryStatus !== undefined) return ok(`fx-exit:${o.canaryStatus}`);
        if (o.hollowCanary) return ok("fx-exit:0");
        return ok(`fx-exit:${o.drive && !hidden(tmpfs, CANARY_DIR) ? 0 : 2}`);
      }
      if (script.includes(CMD_MARKER)) {
        const runs = o.cmdExe && o.interopLive && !hidden(tmpfs, CMD_EXE);
        return ok(runs ? `${CMD_MARKER}\nfx-exit:0` : "sh: cmd.exe: not found\nfx-exit:127");
      }
      return ok("");
    },
  };
}
