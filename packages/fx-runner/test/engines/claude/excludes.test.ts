import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentSettingsFor } from "@fx/runner";
import { excludeDenyRules } from "@fulcrumaxe/runner-protocol";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { denyRules } from "../../../src/engines/claude/filePermissions.js";
import { settingsFor } from "../../../src/engines/claude/settingsFile.js";
import { RUN_ID, engineFor, fixtureText, makeFake, makeRig, type Rig } from "./rig.js";

/**
 * D#600 CX-5c: the runner daemon's engine writes a job's excluded paths as deny entries before every agent command, and counts the calls the rules refused the
 * way the cloud's sandbox does. The fake binary stands in for the CLI; the real CLI is the opt-in `test/excludes.live.test.ts`.
 */
const EXCLUDES = ["secret/a.txt", "keys", "src/**/[ab].ts", "(group)/c.txt"];
const settingsFile = (rig: Rig): string => path.join(rig.config.jobsDir, RUN_ID, "settings.json");
const settingsOf = (rig: Rig): { permissions: { deny: string[]; allow: string[] } } & Record<string, unknown> => JSON.parse(readFileSync(settingsFile(rig), "utf8"));
type StartedWith = ReturnType<Rig["startOptions"]> & { excludes?: readonly string[] };
const withExcludes = (rig: Rig, excludes: readonly string[] | undefined): StartedWith => ({ ...rig.startOptions(), ...(excludes === undefined ? {} : { excludes }) });

describe("the settings file carries the job's excludes", () => {
  it("a job with excludes gets the protected-path floor first and the same Read, Grep and Glob entries as the sandbox, and nothing else changes", async () => {
    const rig = makeRig();
    const { handle } = await engineFor(rig).start(withExcludes(rig, EXCLUDES));
    expect((await outcomeOf(handle)).status).toBe("ok");
    const file = settingsOf(rig);
    expect(file.permissions.deny).toEqual([...denyRules(rig.config.protectedPaths), ...excludeDenyRules(EXCLUDES)]);
    expect(file.permissions.deny).toEqual(expect.arrayContaining(["Read(secret/a.txt)", "Read(secret/a.txt/**)", "Read(keys)", "Read(src/**/[ab].ts)", "Read(\\(group\\)/c.txt)", "Grep", "Glob"]));
    // The same file but for the deny list: allow list, mode, sandbox block and hooks off are as without excludes.
    const plain = settingsFor("executor", rig.config.sandboxSettings, rig.workdir, rig.config.protectedPaths) as typeof file;
    expect({ ...file, permissions: { ...file.permissions, deny: [] } }).toEqual({ ...plain, permissions: { ...plain.permissions, deny: [] } });
  });

  it("parity: the excludes' deny entries are exactly the ones the cloud sandbox's settings carry for the same list (any role, any order of the list)", async () => {
    for (const excludes of [EXCLUDES, [...EXCLUDES].reverse(), ["only/this"], ["!bang", "#hash", "trail ", "a(b)", "a[b]{c}"]]) {
      const rig = makeRig();
      await outcomeOf((await engineFor(rig).start(withExcludes(rig, excludes))).handle);
      const sandbox = (agentSettingsFor("executor", excludes).permissions as { deny: string[] }).deny;
      expect(sandbox.length).toBeGreaterThan(0);
      expect(settingsOf(rig).permissions.deny.slice(-sandbox.length)).toEqual(sandbox);
    }
  });

  it("golden: a job without excludes (absent, or an empty list) writes exactly the bytes it wrote before the field existed", async () => {
    const before = makeRig();
    await outcomeOf((await engineFor(before).start(before.startOptions())).handle);
    const golden = readFileSync(settingsFile(before), "utf8");
    expect(golden).toBe(`${JSON.stringify(settingsFor("executor", before.config.sandboxSettings, before.workdir, before.config.protectedPaths), null, 2)}\n`);
    expect(golden).not.toMatch(/"Grep"|"Glob"/);
    for (const excludes of [undefined, [] as string[]]) {
      const rig = makeRig();
      await outcomeOf((await engineFor(rig).start(withExcludes(rig, excludes))).handle);
      // Each rig has its own directories, so the bytes are compared with what the pre-field function gives for that rig.
      expect(readFileSync(settingsFile(rig), "utf8")).toBe(`${JSON.stringify(settingsFor("executor", rig.config.sandboxSettings, rig.workdir, rig.config.protectedPaths), null, 2)}\n`);
    }
  });

  it("the argument list is the one a job without excludes gets: the rules live in the settings file only", async () => {
    const [a, b] = [makeRig(), makeRig()];
    await outcomeOf((await engineFor(a).start(a.startOptions())).handle);
    await outcomeOf((await engineFor(b).start(withExcludes(b, EXCLUDES))).handle);
    const norm = (rig: Rig): string[] => rig.fake.argv().map((arg) => arg.replaceAll(rig.root, "<root>"));
    expect(norm(b)).toEqual(norm(a));
  });

  it("a resume writes the file again with the job's list, even when the file was changed or removed in between", async () => {
    const rig = makeRig();
    const engine = engineFor(rig);
    const first = await engine.start(withExcludes(rig, EXCLUDES));
    await outcomeOf(first.handle);
    const fresh = readFileSync(settingsFile(rig), "utf8");
    // The agent shares the user's uid: pretend an earlier command emptied the deny list.
    const tampered = settingsOf(rig);
    tampered.permissions.deny = [];
    await import("node:fs").then((fs) => fs.writeFileSync(settingsFile(rig), JSON.stringify(tampered)));
    const second = await engine.resume(first.handle, "sess-0001", "next prompt");
    await outcomeOf(second.handle);
    expect(readFileSync(settingsFile(rig), "utf8")).toBe(fresh);
    expect(rig.fake.argv().slice(-2)).toEqual(["--resume", "sess-0001"]);
  });

  it("a session resumed by a later job (a fix round) uses that job's list, not the first job's", async () => {
    const rig = makeRig();
    const engine = engineFor(rig);
    await outcomeOf((await engine.start(withExcludes(rig, EXCLUDES))).handle);
    await outcomeOf((await engine.start({ ...withExcludes(rig, ["only/this"]), resumeSessionId: "sess-0001" } as never)).handle);
    expect(settingsOf(rig).permissions.deny).toEqual([...denyRules(rig.config.protectedPaths), ...excludeDenyRules(["only/this"])]);
    await outcomeOf((await engine.start({ ...withExcludes(rig, undefined), resumeSessionId: "sess-0001" } as never)).handle);
    expect(settingsOf(rig).permissions.deny).toEqual(denyRules(rig.config.protectedPaths));
  });

  it("fails closed: a path that cannot be written as a rule refuses the start before the agent exists, and leaves no settings file", async () => {
    for (const bad of ["", "/abs/x", "a/../b", "a\\b", "a\nb", "a".repeat(513)]) {
      const rig = makeRig();
      await expect(engineFor(rig).start(withExcludes(rig, ["fine", bad]) as never), JSON.stringify(bad)).rejects.toMatchObject({ code: "bad_start_options" });
      expect(existsSync(settingsFile(rig))).toBe(false);
      // Only the questions asked of the binary (--version, --help, auth status) ran: no model command.
      expect(rig.fake.calls().some((call) => call.startsWith("-p"))).toBe(false);
    }
  });

  it("fails closed on more than 500 paths", async () => {
    const rig = makeRig();
    await expect(engineFor(rig).start(withExcludes(rig, Array.from({ length: 501 }, (_, i) => `p/${i}`)) as never)).rejects.toMatchObject({ code: "bad_start_options" });
    expect(existsSync(settingsFile(rig))).toBe(false);
  });
});

/** The recorded subscription stream with planted tool calls before the result line. */
function streamWithRefusals(): string {
  const lines = fixtureText("stream.subscription.jsonl").split("\n").filter((l) => l !== "");
  const at = lines.findIndex((l) => (JSON.parse(l) as { type?: unknown }).type === "result");
  expect(at).toBeGreaterThan(0);
  const use = (id: string, name: string) => ({ type: "assistant", message: { id: `msg_${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input: {} }], usage: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20000, output_tokens: 4 } } });
  const refused = (id: string, text: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] } });
  const planted = [
    use("toolu_read", "Read"), refused("toolu_read", "Permission to use Read has been denied."),
    use("toolu_grep", "Grep"), refused("toolu_grep", "Error: No such tool available: Grep. Grep exists but is not enabled in this context."),
    use("toolu_glob", "Glob"), refused("toolu_glob", "Error: No such tool available: Glob. Glob exists but is not enabled in this context."),
    use("toolu_ls", "LS"), refused("toolu_ls", "Permission to use LS has been denied."),
    // Not counted: a shell error that merely says "permission denied", and a refusal of a tool that is not a read tool.
    use("toolu_bash", "Bash"), refused("toolu_bash", "cat: secret/a.txt: Permission denied"),
    use("toolu_edit", "Edit"), refused("toolu_edit", "Permission to use Edit has been denied."),
    // Not counted: an ordinary read error.
    use("toolu_missing", "Read"), refused("toolu_missing", "File does not exist."),
  ].map((l) => JSON.stringify(l));
  const result = JSON.parse(lines[at]!) as Record<string, unknown>;
  // The final result lists denials too: the Read again (same id, once), and a WebFetch (not a read tool).
  result.permission_denials = [{ tool_name: "Read", tool_use_id: "toolu_read", tool_input: {} }, { tool_name: "WebFetch", tool_use_id: "toolu_web", tool_input: {} }];
  return [...lines.slice(0, at), ...planted, JSON.stringify(result), ...lines.slice(at + 1)].join("\n") + "\n";
}

describe("refused calls are counted the way the cloud's sandbox counts them", () => {
  it("with excludes: Read, LS and the turned-off Grep and Glob count once each; a shell error, an Edit refusal, a WebFetch and a plain read error do not", async () => {
    const rig = makeRig({ fake: makeFake({ stream: streamWithRefusals() }) });
    const { handle } = await engineFor(rig).start(withExcludes(rig, EXCLUDES));
    expect(await outcomeOf(handle)).toMatchObject({ status: "ok", deniedToolCalls: 4 });
  });

  it("without excludes the 'No such tool' answers are not a refusal of ours (the run turned nothing off): only permission refusals count", async () => {
    const rig = makeRig({ fake: makeFake({ stream: streamWithRefusals() }) });
    const { handle } = await engineFor(rig).start(rig.startOptions());
    expect(await outcomeOf(handle)).toMatchObject({ status: "ok", deniedToolCalls: 2 });
  });

  it("a run with nothing refused reports no count (the outcome is the one it always was)", async () => {
    const rig = makeRig();
    const { handle } = await engineFor(rig).start(withExcludes(rig, EXCLUDES));
    expect(await outcomeOf(handle)).not.toHaveProperty("deniedToolCalls");
  });
});
