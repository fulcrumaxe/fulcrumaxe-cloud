import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initCredentialMatches } from "../../src/engines/claude/credentialCheck.js";
import { resolveClaudePath } from "../../src/engines/claude/pin.js";
import { SUBSCRIPTION_TOKEN_VAR } from "../../src/job/cleanEnv.js";
import { buildLayout, controlConfig, play, type CliRun } from "./matrix.js";

/**
 * D#587 B-10.8 / C1 section 1.1: does a job reach its init line with `securityd` denied (mach-lookup) and
 * `CLAUDE_CODE_OAUTH_TOKEN` set? That is the feasibility check for the `outer_seatbelt` tier: if the CLI insists on the Keychain,
 * that tier cannot be built and the PM escalates. The token here is a scripted dummy and the model a loopback fake: no real
 * credential is used. The result is RECORDED, not gated. The run fails only when it proves nothing: the control did not
 * reach its init line, or the denial did not stop `security` from reading a Keychain item.
 */
const ON = process.env.FX_B10 === "1" && process.platform === "darwin";
const DENY = ["com.apple.SecurityServer", "com.apple.securityd", "com.apple.secd"];
// Assembled from fragments so no token-shaped literal sits in the source. It is not any account's token.
const DUMMY_TOKEN = ["sk-ant-", "oat01-", "fx-b10-scripted-stand-in-not-a-credential"].join("");

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!ON)("B-10 securityd-denied init check", () => {
  it("records whether the CLI reaches its init line with securityd denied and an OAuth token in the environment", { timeout: 10 * 60_000 }, async () => {
    const out = process.env.FX_B10_OUT ?? mkdtempSync(path.join(os.tmpdir(), "fx-b10-out-"));
    mkdirSync(out, { recursive: true });
    const layout = buildLayout(os.homedir(), os.tmpdir(), out);
    const work = path.join(layout.base, "securityd");
    rmSync(work, { recursive: true, force: true });
    for (const dir of [work, layout.workspace, layout.tempDir]) mkdirSync(dir, { recursive: true });
    vi.stubEnv(SUBSCRIPTION_TOKEN_VAR, DUMMY_TOKEN);
    const bin = process.env.FX_CANARY_CLAUDE ?? resolveClaudePath(process.env.PATH ?? "");
    const profile = path.join(work, "no-securityd.sb");
    writeFileSync(profile, `(version 1)\n(allow default)\n(deny mach-lookup ${DENY.map((n) => `(global-name "${n}")`).join(" ")})\n`);

    // The denial must bite: a Keychain item the control reads is not readable under the profile.
    const secret = `FXSENT-securityd-${Date.now()}`;
    const add = spawnSync("security", ["add-generic-password", "-a", "fx-b10", "-s", "fx-securityd-canary", "-w", secret, "-U"], { encoding: "utf8" });
    expect(add.status, add.stderr).toBe(0);
    const find = (wrap: string[]): { found: boolean; code: number | null } => {
      const [cmd, ...pre] = [...wrap, "security"];
      const r = spawnSync(cmd!, [...pre, "find-generic-password", "-s", "fx-securityd-canary", "-w"], { encoding: "utf8", timeout: 60_000 });
      return { found: r.stdout.includes(secret), code: r.status };
    };
    const keychainControl = find([]);
    const keychainDenied = find(["sandbox-exec", "-f", profile]);

    const mode = { mode: "subscription" } as const;
    const describeRun = (r: { cli: CliRun; api: { rawRequests: string[] } }): Record<string, unknown> => ({
      reached_init: r.cli.init !== undefined,
      apiKeySource: r.cli.init?.apiKeySource ?? null,
      init_credential_check_passes: r.cli.init !== undefined && initCredentialMatches("subscription", r.cli.init),
      finished_turn: /"type":"result"/.test(r.cli.stdout),
      model_requests: r.api.rawRequests.length,
      exit_code: r.cli.code,
      timed_out: r.cli.timedOut,
      stderr_head: r.cli.stderr.slice(0, 600),
    });
    const base = { bin, argv: controlConfig(layout), layout, mode, timeoutMs: 3 * 60_000 };
    rmSync(layout.configDir, { recursive: true, force: true });
    const control = await play([], base);
    rmSync(layout.configDir, { recursive: true, force: true });
    const denied = await play([], { ...base, wrap: ["sandbox-exec", "-f", profile] });

    const report = { denied_mach_names: DENY, keychain_control_reads_item: keychainControl.found, keychain_denied_reads_item: keychainDenied.found, control: describeRun(control), securityd_denied: describeRun(denied) };
    const reached = report.securityd_denied.reached_init === true;
    const lines = [
      "## B-10 securityd-denied init check (C1 section 1.1, the outer_seatbelt feasibility gate)",
      `- Deny rule: mach-lookup of ${DENY.join(", ")}; the CLI sandbox off; CLAUDE_CODE_OAUTH_TOKEN set to a scripted dummy; the model a loopback fake.`,
      `- Denial bites (the \`security\` tool reading a Keychain item): control reads it = ${keychainControl.found}, under the profile reads it = ${keychainDenied.found}.`,
      `- **Result: the job ${reached ? "REACHES" : "does NOT reach"} its init line with securityd denied.** ${reached ? "Option (a) is not ruled out by the Keychain." : "The CLI insists on the Keychain: option (a) cannot be built and the PM escalates."}`,
      "```json", JSON.stringify(report, null, 2), "```",
    ];
    writeFileSync(path.join(out, "securityd.md"), `${lines.join("\n")}\n`);
    process.stdout.write(`${lines.join("\n")}\n`);

    expect(keychainControl.found, "hollow: the control could not read the Keychain item").toBe(true);
    expect(keychainDenied.found, "the profile did not stop securityd lookups, so the check proves nothing").toBe(false);
    expect(report.control.reached_init, "hollow: the control never reached its init line").toBe(true);
  });
});
