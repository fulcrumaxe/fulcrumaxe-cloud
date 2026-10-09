import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { CliError } from "../../src/cliError.js";
import { configCommand, updateCommand, updatesLine } from "../../src/commands/update.js";
import type { CommandContext, Flags } from "../../src/context.js";
import { UPDATE_STATE_FILE, linkedVersion, loadUpdateState, saveUpdateState } from "../../src/update/versions.js";
import { program, updateWorld, type UpdateWorld } from "../helpers/updateWorld.js";

const T = (v: string): string => `v${v}/fx-runner-linux-x64`;

function ctxOf(w: UpdateWorld): { ctx: CommandContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { ctx: { stateDir: w.stateDir, out: (l) => out.push(l), err: (l) => err.push(l), now: () => w.clock.now, fetchFn: fetch }, out, err };
}

const flags = (entries: Array<[string, string | true]>): Flags => new Map(entries);

async function run(w: UpdateWorld, entries: Array<[string, string | true]>, hostOver: Partial<UpdateWorld["host"]> = {}) {
  const { ctx, out, err } = ctxOf(w);
  const code = await updateCommand(flags(entries), ctx, { ...w.host, ...hostOver }, { tuf: w.tuf });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("update --check", () => {
  it("prints the current and the available version, and installs nothing", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.2.0"), program("1.2.0"));
    const r = await run(w, [["check", true]]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Current version: 1.0.0");
    expect(r.out).toContain("Available version: 1.2.0");
    expect(r.out).toContain("fx-runner update --pin 1.2.0");
    expect(w.tuf.fetchCalls).toEqual([]);
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
  });

  it("says it is up to date when the newest offer is not newer", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.0.0"), program("1.0.0"));
    expect((await run(w, [["check", true]])).out).toContain("fx-runner is up to date.");
  });

  it("a Homebrew path prints the brew line and never anything about installing", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.2.0"), program("1.2.0"));
    const r = await run(w, [["check", true]], { execPath: "/opt/homebrew/Cellar/fx-runner/1.0.0/bin/fx-runner" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("A newer version is available: run brew upgrade fx-runner");
    expect(r.out).not.toContain("--pin");
    expect(w.tuf.fetchCalls).toEqual([]);
  });

  it("an expired timestamp is reported as paused with its date, exit 0", async () => {
    const w = updateWorld();
    w.tuf.listOutcome = { ok: false, state: "paused", code: "metadata_expired", expiredOn: "2026-10-01", message: "updates paused: release metadata expired on 2026-10-01" };
    const r = await run(w, [["check", true]]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Updates paused: release metadata expired on 2026-10-01");
  });

  it("a refusal (bad signature) is exit 1 on stderr, with the closed text", async () => {
    const w = updateWorld();
    w.tuf.listOutcome = { ok: false, state: "refused", code: "bad_signature", message: "release metadata did not carry enough valid signatures; nothing was installed" };
    const r = await run(w, [["check", true]]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("did not carry enough valid signatures");
  });

  it("a build with no root says so and makes no call", async () => {
    const w = updateWorld();
    w.tuf.configured = false;
    const r = await run(w, [["check", true]]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Updates are not configured in this build.");
    expect(w.tuf.listCalls).toBe(0);
  });
});

describe("pin, unpin, rollback through the command", () => {
  it("--pin installs and holds; --unpin releases; --rollback returns", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    const pinned = await run(w, [["pin", "1.1.0"]]);
    expect(pinned.code).toBe(0);
    expect(pinned.out).toContain("Pinned to 1.1.0");
    expect(loadUpdateState(w.stateDir).pinned).toBe("1.1.0");
    expect((await run(w, [["unpin", true]])).out).toBe("Unpinned.");
    const back = await run(w, [["rollback", true]]);
    expect(back.code).toBe(0);
    expect(back.out).toContain("Rolled back to 1.0.0");
  });

  it("--rollback with nothing kept is exit 1 with the closed message", async () => {
    const w = updateWorld();
    const r = await run(w, [["rollback", true]]);
    expect(r.code).toBe(1);
    expect(r.err).toBe("fx-runner: there is no previous version kept to roll back to");
  });

  it("exactly one action is required", async () => {
    const w = updateWorld();
    await expect(run(w, [])).rejects.toThrow(CliError);
    await expect(run(w, [["check", true], ["unpin", true]])).rejects.toThrow(/usage/);
  });
});

describe("config set auto-update", () => {
  it("turns the switch off and on, and rejects other settings and values", () => {
    const w = updateWorld();
    const { ctx, out } = ctxOf(w);
    expect(configCommand(["set", "auto-update", "off"], ctx, w.host)).toBe(0);
    expect(loadUpdateState(w.stateDir).autoUpdate).toBe(false);
    expect(configCommand(["set", "auto-update", "on"], ctx, w.host)).toBe(0);
    expect(loadUpdateState(w.stateDir).autoUpdate).toBe(true);
    expect(out).toEqual(["Automatic updates are off.", "Automatic updates are on."]);
    expect(() => configCommand(["set", "auto-update", "maybe"], ctx, w.host)).toThrow(/on or off/);
    expect(() => configCommand(["set", "colour", "on"], ctx, w.host)).toThrow(/unknown setting/);
    expect(() => configCommand(["get", "auto-update"], ctx, w.host)).toThrow(/usage/);
  });

  it("is written 0600 as JSON with no secret", () => {
    const w = updateWorld();
    const { ctx } = ctxOf(w);
    configCommand(["set", "auto-update", "off"], ctx, w.host);
    const file = path.join(w.stateDir, UPDATE_STATE_FILE);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, autoUpdate: false });
  });
});

describe("the command line", () => {
  const base = { home: undefined, stdout: () => undefined, stderr: () => undefined };

  it("update and config are only available from the program (no host, no run)", async () => {
    const w = updateWorld();
    const err: string[] = [];
    expect(await runCli({ ...base, argv: ["update", "--check"], stateDirOverride: w.stateDir, stderr: (t) => err.push(t) })).toBe(1);
    expect(err.join("")).toContain("only available from the fx-runner program");
  });

  it("goes through the parser: an unknown flag, a value on a switch and three positionals for config", async () => {
    const w = updateWorld();
    const io = { ...base, stateDirOverride: w.stateDir, updateHost: w.host };
    expect(await runCli({ ...io, argv: ["update", "--force"] })).toBe(2);
    expect(await runCli({ ...io, argv: ["update", "--check=yes"] })).toBe(2);
    expect(await runCli({ ...io, argv: ["update"] })).toBe(2);
    expect(await runCli({ ...io, argv: ["config", "set", "auto-update", "off", "extra"] })).toBe(2);
    expect(await runCli({ ...io, argv: ["config", "set", "auto-update", "off"] })).toBe(0);
    expect(loadUpdateState(w.stateDir).autoUpdate).toBe(false);
  });

  it("--help lists the new commands", async () => {
    let text = "";
    await runCli({ ...base, argv: ["--help"], stdout: (t) => (text += t) });
    expect(text).toContain("update --check | --pin <version> | --unpin | --rollback");
    expect(text).toContain("config set auto-update on|off");
  });
});

describe("the doctor Updates line", () => {
  it("shows the version, pinned or not, automatic updates, the last check and 'paused' with its reason", () => {
    const w = updateWorld();
    expect(updatesLine(w.stateDir, { version: "1.0.0", execPath: w.host.execPath }, true)).toEqual({ level: "PASS", detail: "1.0.0; not pinned, automatic updates on, never checked" });
    saveUpdateState(w.stateDir, { version: 1, autoUpdate: false, pinned: "0.9.0", lastCheck: "2026-10-09T06:00:00.000Z", paused: "release metadata expired on 2026-10-01" });
    expect(updatesLine(w.stateDir, { version: "1.0.0", execPath: w.host.execPath }, true)).toEqual({
      level: "WARN",
      detail: "1.0.0; pinned to 0.9.0, automatic updates off, last checked 2026-10-09, updates paused: release metadata expired on 2026-10-01",
    });
  });

  it("not configured: INFO, and it never reads or creates state", () => {
    const w = updateWorld();
    expect(updatesLine(w.stateDir, { version: "1.0.0" }, false)).toEqual({ level: "INFO", detail: "1.0.0; updates are not configured in this build; the runner does not update itself" });
  });

  it("Homebrew: INFO, brew upgrade, automatic updates off", () => {
    const w = updateWorld();
    const line = updatesLine(w.stateDir, { version: "1.0.0", execPath: "/opt/homebrew/Cellar/fx-runner/1.0.0/bin/fx-runner" }, true);
    expect(line.level).toBe("INFO");
    expect(line.detail).toContain("brew upgrade fx-runner");
    expect(line.detail).toContain("automatic updates are off");
  });

  it("damaged state is a WARN that says automatic updates are off, with no file text", () => {
    const w = updateWorld();
    saveUpdateState(w.stateDir, { version: 1, autoUpdate: true });
    const file = path.join(w.stateDir, UPDATE_STATE_FILE);
    // replace the content with junk that must not be echoed
    writeFileSync(file, "secret-looking junk", { mode: 0o600 });
    const line = updatesLine(w.stateDir, { version: "1.0.0" }, true);
    expect(line.level).toBe("WARN");
    expect(line.detail).not.toContain("junk");
    expect(line.detail).toContain("automatic updates are off");
  });
});
