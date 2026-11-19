import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Whether this host lets a test run a child as a subordinate uid of its own user and bind a Unix socket as that uid. The egress tests that prove "a socket made by
 * another uid is left alone" and "another uid cannot enter the 01770 directory" need exactly that: `unshare --map-users=auto --map-groups=auto --setuid=1 --setgid=1`.
 *
 * A host can lack it in two ways, and both look the same to the probe. The `unshare` binary is not on PATH (the self-hosted NixOS runner's systemd service has a
 * reduced PATH without util-linux), or the binary runs and the kernel or the service unit refuses the namespace (PrivateUsers, no subordinate uids,
 * RestrictNamespaces). The probe runs the same command the tests run, binds a socket the same way, and requires that the socket exists and is owned by a different uid.
 * Hosted public CI can create these namespaces, so the tests run there; only a host that really cannot do it skips, and the skip says so.
 *
 * The answer is computed once per process.
 */
export const SUBORDINATE_UID_SKIP_REASON =
  "this host cannot run a child as a subordinate uid in a user namespace and bind a socket as it (`unshare --map-users=auto` is missing, or the service forbids user namespaces or has no subordinate uids); the cases that need another uid skip here and run in hosted CI";

/** The script the tests hand to the other-uid child: bind a socket at argv[1], say BOUND (or the error code), and exit after a moment. */
export const BIND_AS_OTHER_UID_SCRIPT = `const s=require("node:net").createServer();s.listen(process.argv[1],()=>{console.log("BOUND");setTimeout(()=>process.exit(0),200)});s.on("error",(e)=>{console.log(e.code);process.exit(0)});`;

/** The argv that runs `script` (with `args`) in a user namespace as subordinate uid 1; the same words every test uses. */
export const unshareAsOtherUid = (script: string, ...args: string[]): { command: string; argv: string[] } => ({
  command: "unshare",
  argv: ["--map-users=auto", "--map-groups=auto", "--setuid=1", "--setgid=1", process.execPath, "-e", script, ...args],
});

function probe(): boolean {
  let root: string | undefined;
  try {
    root = mkdtempSync(path.join(existsSync("/tmp") ? "/tmp" : os.tmpdir(), "fx-subuid-"));
    // Searchable by others, and a directory the child may write to while it binds, as the tests do.
    chmodSync(root, 0o711);
    const dir = path.join(root, "d");
    mkdirSync(dir, { mode: 0o1777 });
    chmodSync(dir, 0o1777);
    const sock = path.join(dir, "probe.sock");
    const { command, argv } = unshareAsOtherUid(BIND_AS_OTHER_UID_SCRIPT, sock);
    const out = spawnSync(command, argv, { encoding: "utf8", timeout: 20_000 });
    if (out.status !== 0 || out.error !== undefined || out.stdout.trim() !== "BOUND") return false;
    return lstatSync(sock).uid !== process.getuid!();
  } catch {
    return false;
  } finally {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
}

let cached: boolean | undefined;

/** True when a test can bind a socket as another uid on this host; computed once. Prints the skip reason once when it cannot. */
export function canBindAsSubordinateUid(): boolean {
  if (cached === undefined) {
    cached = probe();
    if (!cached) console.info(`[skip] ${SUBORDINATE_UID_SKIP_REASON}`);
  }
  return cached;
}
