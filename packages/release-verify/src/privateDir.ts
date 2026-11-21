import { chmodSync, lstatSync, mkdirSync } from "node:fs";

/** A directory only this user can enter: made 0700 if missing, and refused if it is a link or not a directory. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new Error("not a directory");
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}
