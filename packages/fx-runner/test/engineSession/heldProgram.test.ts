import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { SESSION_READY_LINE } from "../../src/engineHost/guestSession.js";
import { heldProgram } from "../../src/engineSession/standardTier.js";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";

/** D#845 ON-13b1, the standard tier: the session's unit holds the supervisor (the runner's own hidden command) in place of the idle holder. */
describe("the program a standard-tier session's unit holds", () => {
  it("is the runner's own __engine-supervise, started the way the egress forwarder is (the self command's words, then the hidden command), with the CLI's path in its environment", () => {
    expect(heldProgram(["/opt/fictional-runner/node", "/opt/fictional-runner/fx-runner.mjs"], { claudePath: "/opt/fictional-bin/claude" })).toEqual({
      cmd: "/opt/fictional-runner/node",
      args: ["/opt/fictional-runner/fx-runner.mjs", "__engine-supervise"],
      env: { FX_ENGINE_CLAUDE: "/opt/fictional-bin/claude" },
    });
    expect(heldProgram(["/opt/fictional-runner/fx-runner"], { claudePath: "/c" }).args).toEqual(["__engine-supervise"]);
  });

  it("is the idle holder only when no supervisor is asked for, and says the same ready line the supervisor says", () => {
    const idle = heldProgram(["/opt/fictional-runner/fx-runner"], undefined);
    expect(idle).toEqual({ cmd: "sh", args: ["-c", `echo ${SESSION_READY_LINE}; exec sleep infinity`], env: {} });
  });

  it("the runner's own run command asks for the supervisor, with the CLI path it already resolved", () => {
    const run = readFileSync(path.join(PACKAGE_DIR, "src", "commands", "run.ts"), "utf8");
    expect(run).toMatch(/createStandardSessionParts\(\{[^\n]*supervise: host\.engineSupervise === true \? \{ claudePath: binaryPath \} : undefined \}\)/);
  });

  it("is OFF by default: the supervisor is held only when the host sets engineSupervise, which bin/fx-runner.mjs does from FX_ENGINE_SUPERVISE=1 (Ruling 115: the idle holder stays until a real bwrap run proves the CLI can start there)", () => {
    const bin = readFileSync(path.join(PACKAGE_DIR, "bin", "fx-runner.mjs"), "utf8");
    expect(bin).toContain('engineSupervise: process.env.FX_ENGINE_SUPERVISE === "1"');
    const run = readFileSync(path.join(PACKAGE_DIR, "src", "commands", "run.ts"), "utf8");
    expect(run).not.toMatch(/supervise: \{ claudePath: binaryPath \} \}\)/);
  });

  it("the hidden command is refused when the program did not hand in the supervisor (a run from source has none)", async () => {
    let err = "";
    const code = await runCli({ argv: ["__engine-supervise"], home: "/nonexistent-home", stdout: () => undefined, stderr: (t) => (err += t) });
    expect(code).not.toBe(0);
    expect(err).toContain("only available from the fx-runner program");
    // and it takes no argument
    expect(await runCli({ argv: ["__engine-supervise", "x"], home: "/nonexistent-home", stdout: () => undefined, stderr: () => undefined })).toBe(2);
  });

  it("bin/fx-runner.mjs hands the supervisor the CLI path from its environment and refuses to run without it", () => {
    const bin = readFileSync(path.join(PACKAGE_DIR, "bin", "fx-runner.mjs"), "utf8");
    expect(bin).toContain("engineSupervise:");
    expect(bin).toMatch(/process\.env\.FX_ENGINE_CLAUDE === undefined\s*\?\s*Promise\.resolve\(2\)/);
  });
});
