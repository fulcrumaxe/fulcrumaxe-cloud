import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import type { TufOutcome } from "../../src/update/tuf.js";
import { Updater, type UpdateHost, type UpdaterDeps } from "../../src/update/updater.js";
import { versionBinary } from "../../src/update/versions.js";

/**
 * A state directory in the layout install.sh makes, a real fixture program for each version, a real process start for the start check,
 * and a stand-in for the release client that counts what it is asked. Test keys and fixtures only.
 */

/** A program that answers like fx-runner: its version line, and `doctor --sandbox-only` with a chosen exit code. */
export function program(version: string, opts: { doctorExit?: number; versionLine?: string; failViaLink?: boolean; markViaLink?: string } = {}): Buffer {
  return Buffer.from(
    [
      "#!/bin/sh",
      opts.markViaLink === undefined ? "" : `case "$0" in */bin/fx-runner) echo started >> "${opts.markViaLink}";; esac`,
      opts.failViaLink === true ? 'case "$0" in */bin/fx-runner) exit 9;; esac' : "",
      'case "$1" in',
      `  --version) echo "${opts.versionLine ?? `fx-runner ${version} (test)`}";;`,
      `  doctor) exit ${opts.doctorExit ?? 0};;`,
      "  *) exit 64;;",
      "esac",
      "",
    ].join("\n"),
  );
}

export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

export function realRun(file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(file, args, { env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs, killSignal: "SIGKILL" });
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.on("error", () => resolve({ code: null, stdout: "" }));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

export class FakeTuf {
  configured = true;
  listCalls = 0;
  fetchCalls: string[] = [];
  files = new Map<string, Buffer>();
  /** When set, the next `listTargets` answers this instead of the files' names. */
  listOutcome: Exclude<TufOutcome, { ok: true }> | undefined;
  fetchOutcome: Exclude<TufOutcome, { ok: true }> | undefined;
  /** Claim this hash for the file, whatever its bytes are (a file changed after it was verified). */
  lieAboutHash: string | undefined;
  constructor(private readonly dir: string) {}

  add(target: string, content: Buffer): void {
    this.files.set(target, content);
  }

  async listTargets(): Promise<{ ok: true; paths: string[] } | Exclude<TufOutcome, { ok: true }>> {
    this.listCalls++;
    return this.listOutcome ?? { ok: true, paths: [...this.files.keys()] };
  }

  async fetchTarget(target: string): Promise<TufOutcome> {
    this.fetchCalls.push(target);
    if (this.fetchOutcome !== undefined) return this.fetchOutcome;
    const content = this.files.get(target);
    if (content === undefined) return { ok: false, state: "refused", code: "target_not_found", message: "the release metadata does not list that file" };
    const file = path.join(this.dir, `dl-${this.fetchCalls.length}`);
    writeFileSync(file, content, { mode: 0o600 });
    return { ok: true, file, remotePath: target, length: content.length, sha256: this.lieAboutHash ?? sha256(content) };
  }
}

export interface UpdateWorld {
  root: string;
  stateDir: string;
  tuf: FakeTuf;
  host: UpdateHost;
  updater: Updater;
  clock: { now: Date };
  /** A new Updater over the same disk (what a restart sees), with host changes. */
  updaterWith(over?: Partial<UpdateHost>, deps?: Partial<UpdaterDeps>): Updater;
}

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Installs `installed` (versions, the first of which the link names) the way install.sh does. */
export function updateWorld(opts: { installed?: string[]; current?: string; over?: Partial<UpdateHost> } = {}): UpdateWorld {
  const root = mkdtempSync(path.join(tmpdir(), "fxr-upd-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const current = opts.current ?? "1.0.0";
  for (const version of opts.installed ?? [current]) {
    mkdirSync(path.join(stateDir, "versions", version), { recursive: true });
    writeFileSync(versionBinary(stateDir, version), program(version), { mode: 0o755 });
    chmodSync(versionBinary(stateDir, version), 0o755);
  }
  mkdirSync(path.join(stateDir, "bin"), { recursive: true });
  symlinkSync(`../versions/${current}/fx-runner`, path.join(stateDir, "bin", "fx-runner"));
  const tufDir = path.join(root, "downloads");
  mkdirSync(tufDir);
  const tuf = new FakeTuf(tufDir);
  const clock = { now: new Date("2026-10-09T12:00:00.000Z") };
  const host: UpdateHost = { version: current, platform: "linux", arch: "x64", execPath: versionBinary(stateDir, current), inService: false, run: realRun, ...opts.over };
  const make = (over: Partial<UpdateHost> = {}, deps: Partial<UpdaterDeps> = {}): Updater => new Updater({ stateDir, host: { ...host, ...over }, now: () => clock.now, tuf, ...deps });
  return { root, stateDir, tuf, host, updater: make(), clock, updaterWith: make };
}

export const readBytes = (file: string): Buffer => readFileSync(file);
