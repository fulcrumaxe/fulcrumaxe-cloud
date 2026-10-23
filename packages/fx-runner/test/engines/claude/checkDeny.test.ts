import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { checkCommandDenyRules, denyRules } from "../../../src/engines/claude/filePermissions.js";
import { settingsFor } from "../../../src/engines/claude/settingsFile.js";
import { CHECK_NOT_YOURS, checkNote } from "../../../src/job/prompt.js";
import { RUN_ID, engineFor, makeRig, type Rig } from "./rig.js";

/**
 * D#6 RUNNER-AGENT-NO-FULLCHECK: an agent in a job with an approved check is told not to run it, and its settings deny the command verbatim (and its plain
 * spellings), so the whole suite is not run inside the agent's own memory limit. The runner runs the check itself, after the agent. The real CLI's matching of
 * these rules is the opt-in `test/checkDeny.live.test.ts`.
 */
const CHECK_ARGV = ["bash", "scripts/check.sh"];
const settingsFile = (rig: Rig): string => path.join(rig.config.jobsDir, RUN_ID, "settings.json");
const denyOf = (rig: Rig): string[] => (JSON.parse(readFileSync(settingsFile(rig), "utf8")) as { permissions: { deny: string[] } }).permissions.deny;

describe("checkCommandDenyRules", () => {
  it("denies the signed vector and the plain spellings of the same script, each bare and as a prefix", () => {
    const rules = checkCommandDenyRules(CHECK_ARGV);
    for (const command of ["bash scripts/check.sh", "sh scripts/check.sh", "scripts/check.sh", "bash ./scripts/check.sh", "sh ./scripts/check.sh", "./scripts/check.sh"]) {
      expect(rules, command).toContain(`Bash(${command})`);
      expect(rules, command).toContain(`Bash(${command}:*)`);
    }
    expect(new Set(rules).size).toBe(rules.length);
    expect(rules).toHaveLength(12);
  });

  it("keeps the vector's other words, and adds no spelling for a command that is not a shell running a script", () => {
    expect(checkCommandDenyRules(["bash", "./ci.sh", "--quick"])).toEqual(expect.arrayContaining(["Bash(bash ./ci.sh --quick)", "Bash(./ci.sh --quick:*)", "Bash(sh ci.sh --quick:*)"]));
    // `ci.sh` started directly would be looked up on PATH: not this script, so no rule for it.
    expect(checkCommandDenyRules(["bash", "./ci.sh"])).not.toContain("Bash(ci.sh)");
    expect(checkCommandDenyRules(["pnpm", "run", "check:all"])).toEqual(["Bash(pnpm run check:all)", "Bash(pnpm run check:all:*)"]);
    expect(checkCommandDenyRules(["make", "check"])).toEqual(["Bash(make check)", "Bash(make check:*)"]);
  });

  it("writes no rule for a vector it cannot write literally, and none for no check (it never refuses the start)", () => {
    for (const argv of [["bash", "-c", "pnpm test && echo ok"], ["bash", "scripts/check(1).sh"], ["bash", "a*b.sh"], ["bash", "x\ny"], ["bash", ""], []]) expect(checkCommandDenyRules(argv), JSON.stringify(argv)).toEqual([]);
    expect(checkCommandDenyRules(undefined)).toEqual([]);
  });
});

describe("the settings file carries the check's deny rules", () => {
  it("a job with a check gets the protected floor first, then the check's rules; the allow list, mode and sandbox are unchanged", async () => {
    const rig = makeRig();
    const { handle } = await engineFor(rig).start({ ...rig.startOptions(), checkArgv: CHECK_ARGV } as ReturnType<Rig["startOptions"]>);
    expect((await outcomeOf(handle)).status).toBe("ok");
    expect(denyOf(rig)).toEqual([...denyRules(rig.config.protectedPaths), ...checkCommandDenyRules(CHECK_ARGV)]);
    const file = JSON.parse(readFileSync(settingsFile(rig), "utf8")) as { permissions: Record<string, unknown> } & Record<string, unknown>;
    const plain = settingsFor("executor", rig.config.sandboxSettings, rig.workdir, rig.config.protectedPaths) as typeof file;
    expect({ ...file, permissions: { ...file.permissions, deny: [] } }).toEqual({ ...plain, permissions: { ...plain.permissions, deny: [] } });
  });

  it("a job without a check writes exactly the bytes it wrote before the field existed", async () => {
    const rig = makeRig();
    await outcomeOf((await engineFor(rig).start(rig.startOptions())).handle);
    expect(readFileSync(settingsFile(rig), "utf8")).toBe(`${JSON.stringify(settingsFor("executor", rig.config.sandboxSettings, rig.workdir, rig.config.protectedPaths), null, 2)}\n`);
  });

  it("a resume writes the rules again", async () => {
    const rig = makeRig();
    const engine = engineFor(rig);
    const first = await engine.start({ ...rig.startOptions(), checkArgv: CHECK_ARGV } as ReturnType<Rig["startOptions"]>);
    await outcomeOf(first.handle);
    const fresh = readFileSync(settingsFile(rig), "utf8");
    await import("node:fs").then((fs) => fs.writeFileSync(settingsFile(rig), "{}"));
    await outcomeOf((await engine.resume(first.handle, "sess-0001", "next prompt")).handle);
    expect(readFileSync(settingsFile(rig), "utf8")).toBe(fresh);
  });

  it("the review roles get the same rules", () => {
    for (const role of ["code-reviewer", "acceptance-tester", "security-reviewer", "debater"]) {
      const deny = (settingsFor(role, { enabled: true }, "/w/job", { noAccess: [], noEdit: [] }, [], undefined, CHECK_ARGV) as { permissions: { deny: string[] } }).permissions.deny;
      expect(deny, role).toEqual(checkCommandDenyRules(CHECK_ARGV));
    }
  });
});

describe("the check note", () => {
  const CHECK = { argv: CHECK_ARGV, dev_shell: false };
  it("tells a builder the runner runs the check after it, a failure starts a fix round, and not to run it; only the affected tests", () => {
    const note = checkNote(CHECK, "executor");
    expect(note).toContain("`bash scripts/check.sh`");
    expect(note).toContain("a failure starts a fix round");
    expect(note).toContain(CHECK_NOT_YOURS);
    expect(CHECK_NOT_YOURS).toMatch(/^Do not run that command yourself/);
    expect(CHECK_NOT_YOURS).toContain("Run only the tests that cover the files this change touches");
    expect(checkNote(CHECK)).toBe(note);
  });

  it("tells a reviewer the same, without a fix-round promise and without claiming any earlier result", () => {
    for (const role of ["code-reviewer", "acceptance-tester", "security-reviewer", "debater"]) {
      const note = checkNote(CHECK, role);
      expect(note, role).toContain("its result is recorded with this run");
      expect(note, role).not.toContain("fix round");
      expect(note, role).not.toMatch(/passed/);
      expect(note, role).toContain(CHECK_NOT_YOURS);
    }
  });

  it("names the dev shell when the check uses it", () => {
    expect(checkNote({ ...CHECK, dev_shell: true }, "code-reviewer")).toContain("with the repository's dev shell environment applied");
    expect(checkNote(CHECK, "code-reviewer")).not.toContain("dev shell");
  });
});
