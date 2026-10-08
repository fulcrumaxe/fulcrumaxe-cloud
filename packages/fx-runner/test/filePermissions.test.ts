import { describe, expect, it } from "vitest";
import { EngineRefusal } from "../src/engines/claude/refusal.js";
import { confineFileTools, denyRules } from "../src/engines/claude/filePermissions.js";
import { ROLE_TOOLS, roleToolsDigest, roleToolsFor } from "../src/job/roleTools.js";
import { CREDENTIAL_FLOOR, PERSISTENCE_TARGETS, protectedPaths, type ProtectedPaths } from "../src/sandbox/sandboxSettings.js";

const HOME = "/home/jane";
const WS = "/home/jane/work/run-1";
const LIST = protectedPaths({ home: HOME, stateDir: `${HOME}/.fx-runner`, binaryDir: `${HOME}/.local/share/claude/bin` });

/** A small model of the CLI's documented rule matching, enough to ask "is this call allowed": deny first, then allow; `//x` is absolute; `/**` is the tree. */
function matches(rule: string, tool: "Read" | "Edit", file: string): boolean {
  const m = /^(Read|Edit)\(\/(\/.*)\)$/.exec(rule);
  if (m === null || m[1] !== tool) return false;
  const pattern = m[2]!;
  return pattern.endsWith("/**") ? file === pattern.slice(0, -3) || file.startsWith(`${pattern.slice(0, -2)}`) : file === pattern;
}
function decide(tool: "Read" | "Edit", file: string, allow: string[], deny: string[]): "deny" | "allow" | "none" {
  if (deny.some((rule) => matches(rule, tool, file)) || (tool === "Edit" && deny.some((rule) => matches(rule, "Read", file)))) return "deny";
  return allow.some((rule) => matches(rule, tool, file)) ? "allow" : "none";
}

describe("confineFileTools: one table, nothing dropped and nothing added", () => {
  it.each([
    ["Read", [`Read(//home/jane/work/run-1)`, `Read(//home/jane/work/run-1/**)`]],
    ["Glob", [`Read(//home/jane/work/run-1)`, `Read(//home/jane/work/run-1/**)`]],
    ["Grep", [`Read(//home/jane/work/run-1)`, `Read(//home/jane/work/run-1/**)`]],
    ["LS", [`Read(//home/jane/work/run-1)`, `Read(//home/jane/work/run-1/**)`]],
    ["Edit", [`Edit(//home/jane/work/run-1/**)`]],
    ["Write", [`Edit(//home/jane/work/run-1/**)`]],
    ["MultiEdit", [`Edit(//home/jane/work/run-1/**)`]],
    ["NotebookEdit", [`Edit(//home/jane/work/run-1/**)`]],
    ["Bash(git:*)", ["Bash(git:*)"]],
    ["Bash(pwd)", ["Bash(pwd)"]],
  ])("%s", (tool, expected) => {
    expect(confineFileTools([tool], WS)).toEqual(expected);
  });

  it("every role's entry loses its bare file tools, keeps every other entry in order, and the digest still comes from the unconfined list", () => {
    for (const role of Object.keys(ROLE_TOOLS)) {
      const entry = roleToolsFor(role);
      const out = confineFileTools(entry, WS);
      for (const bare of ["Read", "Glob", "Grep", "LS", "Edit", "Write", "MultiEdit", "NotebookEdit"]) expect(out, `${role} ${bare}`).not.toContain(bare);
      expect(out.filter((rule) => !/^(Read|Edit)\(/.test(rule))).toEqual(entry.filter((tool) => !/^(Read|Glob|Grep|LS|Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)));
      expect(entry).toContain("Read");
      expect(roleToolsDigest(role)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("refuses a workspace that cannot be written literally in a rule", () => {
    for (const bad of ["relative/ws", "/home/jane/we*rd", "/home/jane/a[b]", "/home/jane/!x", "/home/jane/a)b"]) expect(() => confineFileTools(["Read"], bad), bad).toThrow(EngineRefusal);
  });
});

describe("the rules, as the CLI would apply them", () => {
  const allow = confineFileTools(roleToolsFor("executor"), WS);
  const deny = denyRules(LIST);

  it("allows the workspace, and nothing else, for reading and editing", () => {
    expect(decide("Read", `${WS}/src/a.ts`, allow, deny)).toBe("allow");
    expect(decide("Edit", `${WS}/src/a.ts`, allow, deny)).toBe("allow");
    expect(decide("Read", "/home/jane/notes.txt", allow, deny)).toBe("none");
    expect(decide("Edit", "/home/jane/work/run-2/a.ts", allow, deny)).toBe("none");
    expect(decide("Edit", "/tmp/x", allow, deny)).toBe("none");
  });

  it("denies a read of ~/.ssh/x and ~/.fx-runner/keys, and an edit of the stored binary's directory", () => {
    expect(decide("Read", `${HOME}/.ssh/x`, allow, deny)).toBe("deny");
    expect(decide("Read", `${HOME}/.fx-runner/keys/private.pem`, allow, deny)).toBe("deny");
    expect(decide("Edit", `${HOME}/.local/share/claude/bin/claude`, allow, deny)).toBe("deny");
  });

  it("denies an edit of ~/.bashrc and the systemd user directory, and leaves reading them to the sandbox", () => {
    expect(decide("Edit", `${HOME}/.bashrc`, allow, deny)).toBe("deny");
    expect(decide("Edit", `${HOME}/.config/systemd/user/x.service`, allow, deny)).toBe("deny");
    expect(deny.filter((rule) => rule.startsWith("Read(") && /bashrc|systemd|LaunchAgents|gitconfig/.test(rule))).toEqual([]);
  });

  // Mutation proof: for each class, take it out of the list and the same call is no longer denied, so the assertions above would fail.
  const classes: Array<[string, (list: ProtectedPaths) => ProtectedPaths, "Read" | "Edit", string]> = [
    ["credential floor", (l) => ({ ...l, noAccess: l.noAccess.slice(CREDENTIAL_FLOOR.length) }), "Read", `${HOME}/.ssh/x`],
    ["state directory", (l) => ({ ...l, noAccess: l.noAccess.filter((p) => !p.endsWith(".fx-runner")) }), "Read", `${HOME}/.fx-runner/config.json`],
    ["binary directory", (l) => ({ ...l, noAccess: l.noAccess.filter((p) => !p.endsWith("claude/bin")) }), "Edit", `${HOME}/.local/share/claude/bin/claude`],
    ["persistence files", (l) => ({ ...l, noEdit: [] }), "Edit", `${HOME}/.zshrc`],
  ];
  it.each(classes)("mutation: without the %s the call is no longer denied", (_name, drop, tool, file) => {
    expect(decide(tool, file, allow, deny)).toBe("deny");
    expect(decide(tool, file, allow, denyRules(drop(LIST)))).not.toBe("deny");
  });

  it("covers every path of the one list, both for itself and for what is under it", () => {
    for (const p of [...LIST.noAccess, ...LIST.noEdit]) for (const rule of [`Edit(/${p})`, `Edit(/${p}/**)`]) expect(deny, rule).toContain(rule);
    for (const p of LIST.noAccess) expect(deny).toContain(`Read(/${p}/**)`);
    expect(LIST.noEdit.length).toBe(PERSISTENCE_TARGETS.length);
    for (const target of [".bashrc", ".profile", ".zshrc", ".config/systemd/user", "Library/LaunchAgents", ".config/autostart", ".gitconfig", ".config/git"]) expect(PERSISTENCE_TARGETS).toContain(target);
  });
});
