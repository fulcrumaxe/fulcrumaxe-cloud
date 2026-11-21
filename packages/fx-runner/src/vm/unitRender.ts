/**
 * The TypeScript twin of `hardening.Pinned.RenderUnit` (the vmhelper hardening package). It reads the same
 * `hardening.json` and restates none of its values: every directive, capability, directory and mode comes from that file, and
 * the golden files under `vmhelper/internal/hardening/testdata` (written by the Go renderer, read by a test here) fail the build on
 * any difference between the two. Nothing here runs a downloaded binary: it only builds text.
 */
import pinnedJson from "../../vmhelper/internal/hardening/hardening.json";

export interface Pinned {
  readonly runtime_directory: string;
  readonly runtime_directory_mode: string;
  readonly socket_name: string;
  readonly state_directory: string;
  readonly state_directory_mode: string;
  readonly read_write_paths: readonly string[];
  readonly directives: Readonly<Record<string, string | readonly string[]>>;
  readonly capabilities: readonly { readonly name: string; readonly number: number; readonly reason: string; readonly jailer_only?: boolean }[];
}

export interface UnitParams {
  readonly helperPath: string;
  readonly configPath: string;
  readonly jailRoot: string;
  /** The config's snapshot_dir: under ProtectSystem=strict it is read-only unless the unit lists it. */
  readonly snapshotDir: string;
  /** Optional: the group that owns the RuntimeDirectory (the runner's group). */
  readonly group?: string;
}

/** The pinned file, checked for the shape the Go loader requires. */
export function loadPinned(source: unknown = pinnedJson): Pinned {
  const p = source as Partial<Pinned> | null;
  const mode = /^0[0-7]{3}$/;
  if (
    p === null ||
    typeof p !== "object" ||
    !p.runtime_directory ||
    !p.socket_name ||
    !p.state_directory ||
    !Array.isArray(p.capabilities) ||
    p.capabilities.length === 0 ||
    p.directives === undefined ||
    Object.keys(p.directives).length === 0 ||
    !mode.test(p.runtime_directory_mode ?? "") ||
    !mode.test(p.state_directory_mode ?? "") ||
    !Array.isArray(p.read_write_paths)
  ) {
    throw new Error("hardening.json: a required value is missing or malformed");
  }
  return p as Pinned;
}

const HARDENING: Pinned = loadPinned();

/** Where the helper listens: inside its RuntimeDirectory. */
export const socketPath = (p: Pinned = HARDENING): string => `/run/${p.runtime_directory}/${p.socket_name}`;
export const runtimeDirPath = (p: Pinned = HARDENING): string => `/run/${p.runtime_directory}`;
export const stateDirPath = (p: Pinned = HARDENING): string => `/var/lib/${p.state_directory}`;

// The same bytes the Go safeToken refuses.
const BAD_TOKEN = /[ \t\r\n\0%"'\\$;]/;
const CONTROL_EDGE = /^[\x00-\x1f\x7f]|[\x00-\x1f\x7f]$/;

function safeToken(s: string): boolean {
  return s !== "" && !BAD_TOKEN.test(s) && !CONTROL_EDGE.test(s);
}

function safePath(s: string): boolean {
  // Absolute and clean, as Go's path.Clean(s) == s: no empty, "." or ".." segment, no trailing slash, and not the root.
  return safeToken(s) && s.startsWith("/") && s.length > 1 && s.slice(1).split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** The systemd unit text. It refuses a parameter that could add a directive, exactly as the Go renderer does. */
export function renderUnit(u: UnitParams, p: Pinned = HARDENING): string {
  if (!safePath(u.helperPath) || !safePath(u.configPath) || !safePath(u.jailRoot) || !safePath(u.snapshotDir) || (u.group !== undefined && u.group !== "" && !safeToken(u.group))) {
    throw new Error("unit parameters must be clean absolute paths and a plain group name");
  }
  // No User= line: a system unit runs as root without one, and with User=root written out systemd 255 starts the helper without
  // CAP_SETUID in its effective set.
  const out: string[] = ["[Unit]\nDescription=fx-vmhelper: root service for the local runner's microVM sandboxes\nAfter=local-fs.target\n\n[Service]\nType=simple\n"];
  if (u.group !== undefined && u.group !== "") out.push(`Group=${u.group}\n`);
  out.push(`ExecStart=${u.helperPath} -config ${u.configPath}\nRestart=on-failure\n`);
  out.push(`RuntimeDirectory=${p.runtime_directory}\nRuntimeDirectoryMode=${p.runtime_directory_mode}\nStateDirectory=${p.state_directory}\nStateDirectoryMode=${p.state_directory_mode}\n`);
  out.push(`ReadWritePaths=${[...p.read_write_paths, u.jailRoot, u.snapshotDir].join(" ")}\n`);
  out.push(`CapabilityBoundingSet=${p.capabilities.map((c) => c.name).join(" ")}\n`);
  for (const k of Object.keys(p.directives).sort()) {
    const v = p.directives[k]!;
    for (const line of typeof v === "string" ? [v] : v) out.push(`${k}=${line}\n`);
  }
  out.push("\n[Install]\nWantedBy=multi-user.target\n");
  return out.join("");
}
