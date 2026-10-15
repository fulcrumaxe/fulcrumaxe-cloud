import path from "node:path";
import type { Writable } from "./output.js";

/** Everything the CLI touches in the outside world, so a test can hand it a fake home, a fake uid or a fake platform. */
export interface Io {
  env: Record<string, string | undefined>;
  stdout: Writable;
  stderr: Writable;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  platform: NodeJS.Platform;
  uid: number | undefined;
  home: string;
  /** Waits `ms`; replaced in tests that must not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** `${XDG_CONFIG_HOME:-$HOME/.config}/fulcrumaxe` */
export function configDir(io: Io): string {
  const xdg = io.env["XDG_CONFIG_HOME"];
  return path.join(xdg !== undefined && xdg !== "" ? xdg : path.join(io.home, ".config"), "fulcrumaxe");
}
