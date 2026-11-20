import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../../src/cliError.js";
import { ROOT_PATH, createVmInstallHosts } from "../../scripts/vm-install-host.mjs";
import { UNINSTALL_USAGE, buildRemoveArgv, rootRemoveCommand, uninstallCommand, type UninstallHost } from "../../src/vm/uninstall.js";
import { buildUninstallActions, checkUninstallRequest, describeUninstall, uninstallPathActions, uninstallPlan, type UninstallAction, type UninstallRequest } from "../../src/vm/uninstallActions.js";
import { applyUninstall } from "../../src/vm/uninstallApply.js";
import { HELPER_GROUP, LAYOUT, uninstallList } from "../../src/vm/installPlan.js";
import { renderRecord } from "../../src/vm/installRecord.js";
import { buildRootArgv } from "../../src/vm/install.js";
import { hostRefusal, type RootOps } from "../../src/vm/rootApply.js";
import { vmCommand } from "../../src/vm/command.js";

/** D#587 B-2a-2 PR-4: `vm uninstall`. Nothing here calls sudo, systemctl or any real account program: the root executor and the program runner are fakes, and the files are in a scratch directory. */
const UID = process.getuid!();
const GID = process.getgid!();
const plan = uninstallPlan("alice");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});
const scratch = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "fx-uninstall-test-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const short = (a: UninstallAction): string => (a.op === "remove-file" ? `file ${a.path} ${a.owner} ${a.mode}` : a.op === "remove-dir" ? `dir ${a.path} ${a.owner} ${a.mode}${a.tree === true ? " tree" : ""}` : a.op === "stop-disable" ? `stop ${a.unit}` : a.op === "remove-member" ? `member ${a.user} ${a.group}` : a.op === "remove-group" ? `group ${a.name}` : a.op);

describe("the uninstall actions", () => {
  const actions = buildUninstallActions(plan, { user: "alice" });

  it("is the create list in reverse, except that the record and its directory go last: the service, the directories and files with their owner and mode, the membership and the group, then the record", () => {
    expect(actions.map(short)).toEqual([
      "stop fx-vmhelper.service",
      "dir /run/fx-vmhelper root:fx-vmhelper 0750",
      "dir /var/lib/fx-vmhelper root:root 0700 tree",
      "dir /var/lib/fx-vm-snapshots root:root 0700",
      "dir /var/lib/fx-vm root:root 0711",
      "file /etc/systemd/system/fx-vmhelper.service root:root 0644",
      "daemon-reload",
      "file /etc/fx-vmhelper/config.json root:root 0600",
      "dir /opt/fx-vmhelper root:root 0755 tree",
      "member alice fx-vmhelper",
      "group fx-vmhelper",
      "file /etc/fx-vmhelper/install-record.json root:root 0600",
      "dir /etc/fx-vmhelper root:root 0755",
    ]);
    // every path step is an item of the create list, and the list has no path the create list lacks (the id ranges are released with the config)
    const targets = uninstallList(plan).map((i) => i.target);
    for (const a of actions) if ("path" in a) expect(targets).toContain(a.path);
    expect(actions.filter((a) => "path" in a)).toHaveLength(uninstallList(plan).filter((i) => i.kind === "directory" || i.kind === "file" || i.kind === "unit").length);
  });

  it("removes the snapshot directory install made only as root:root 0700 and only when empty (never with what is in it), and the jail root is never removed with what is in it", () => {
    // the one snapshot place is the install's own: plain, not a tree, so a directory that still holds snapshots stays and is reported as left in place
    const snaps = actions.filter((a) => JSON.stringify(a).includes("snapshot"));
    expect(snaps).toEqual([{ op: "remove-dir", path: LAYOUT.snapshotDir, owner: "root:root", mode: "0700" }]);
    expect(actions.filter((a) => a.op === "remove-dir" && a.tree === true).map((a) => (a as { path: string }).path).sort()).toEqual([LAYOUT.helperDir, "/var/lib/fx-vmhelper"].sort());
    expect(actions.map(describeUninstall).join("\n")).not.toMatch(/null|undefined/);
  });

  it("the root side's check accepts exactly this list and refuses anything else, as a whole", () => {
    const req: UninstallRequest = { version: 1, runnerUid: 1000, runnerUser: "alice", actions };
    expect(checkUninstallRequest(JSON.parse(JSON.stringify(req)), 0)).toMatchObject({ runnerUser: "alice" });
    const refuse = (v: unknown, euid = 0): void => expect(() => checkUninstallRequest(v, euid)).toThrow(CliError);
    refuse(req, 1000);
    refuse({ ...req, runnerUid: 0 });
    refuse({ ...req, runnerUser: "alice; rm -rf" });
    refuse({ ...req, actions: [...actions, { op: "remove-dir", path: "/home/alice/snapshots", owner: "root:root", mode: "0755", tree: true }] });
    refuse({ ...req, actions: actions.slice(1) });
    refuse({ ...req, actions: actions.map((a) => (a.op === "remove-dir" && a.path === LAYOUT.jailRoot ? { ...a, tree: true } : a)) });
    refuse({ ...req, actions: actions.map((a) => (a.op === "remove-file" ? { ...a, path: "/etc/passwd" } : a)) });
    refuse({ ...req, version: 2 });
    refuse(null);
  });

  it("refuses a user name that would reach gpasswd or groupdel as an option, even when the list was built for that very name", () => {
    for (const user of ["-x", "--help", "A", "a b", ""]) {
      const list = buildUninstallActions(uninstallPlan("alice"), { user });
      expect(() => checkUninstallRequest({ version: 1, runnerUid: 1000, runnerUser: user, actions: list }, 0), user).toThrow(/runner uid must be the invoking user's/);
    }
  });

  it("builds the one fixed root argument list", () => {
    expect(buildRemoveArgv("/usr/bin/sudo", ["/usr/bin/node", "/x/fx-runner.mjs"])).toEqual(["/usr/bin/sudo", "--", "/usr/bin/node", "/x/fx-runner.mjs", "vm", "root-remove"]);
  });
});

/** Programs the root side starts, faked. `ownerUid` is what the account database says root is: another number makes every owner look wrong. */
function fakeOps(opts: { active?: boolean; failOn?: string; ownerUid?: number; noGroup?: boolean } = {}) {
  const calls: string[] = [];
  const groups = new Map<string, string[]>(opts.noGroup === true ? [] : [[HELPER_GROUP, ["alice"]]]);
  let active = opts.active ?? true;
  const ops: RootOps = {
    run: async (file, args) => {
      if (file === "getent") {
        if (args[0] === "passwd") return { code: 0, output: `${args[1]}:x:${args[1] === "root" ? (opts.ownerUid ?? UID) : UID}:${GID}::/:/bin/sh\n` };
        const members = groups.get(args[1]!);
        return args[1] === "root" || members !== undefined ? { code: 0, output: `${args[1]}:x:${GID}:${(members ?? []).join(",")}\n` } : { code: 2, output: "" };
      }
      const line = `${file} ${args.join(" ")}`;
      calls.push(line);
      if (opts.failOn !== undefined && line.startsWith(opts.failOn)) return { code: 1, output: "" };
      if (file === "groupdel") groups.delete(args[1]!);
      if (file === "gpasswd") groups.set(args[2]!, (groups.get(args[2]!) ?? []).filter((m) => m !== args[1]));
      if (file === "systemctl" && args[0] === "disable") active = false;
      return { code: file === "systemctl" && (args[0] === "is-enabled" || args[0] === "is-active") ? (active ? 0 : 1) : 0, output: "" };
    },
    probe: async () => true,
  };
  return { ops, calls, groups, mutating: () => calls.filter((c) => !/is-(enabled|active)/.test(c)) };
}

/** What install made, in a scratch directory: every create-list path at its stated mode (owned by this user, which the fake account database calls root), the files install and the helper put inside, install's record, and a snapshot directory. */
function lay(S: string, record: { group_created: boolean; members_added: string[] } | null = { group_created: true, members_added: ["alice"] }) {
  const at = new Map<string, string>();
  for (const i of plan.createList) if (i.kind === "directory" || i.kind === "file" || i.kind === "unit") at.set(i.target, path.join(S, i.target));
  const where = (p: string): string => at.get(p)!;
  for (const i of plan.createList) {
    if (i.kind === "directory") mkdirSync(where(i.target), { recursive: true });
    if (i.kind === "file" || i.kind === "unit") {
      mkdirSync(path.dirname(where(i.target)), { recursive: true });
      writeFileSync(where(i.target), `${i.target}\n`);
    }
  }
  if (record === null) rmSync(where(LAYOUT.recordFile));
  else writeFileSync(where(LAYOUT.recordFile), renderRecord(record));
  const inside = (dir: string, rel: string, mode: number): string => {
    const f = path.join(where(dir), rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, "x\n");
    chmodSync(f, mode);
    return f;
  };
  inside(LAYOUT.helperDir, "bin/fx-vmhelper", 0o755);
  inside(LAYOUT.helperDir, "templates/fx-agent/rootfs", 0o644);
  inside("/var/lib/fx-vmhelper", "registry.json", 0o600);
  const snapshots = path.join(S, "home/alice/snapshots");
  mkdirSync(snapshots, { recursive: true });
  writeFileSync(path.join(snapshots, "vm1.snap"), "the person's data\n");
  for (const i of plan.createList) if ((i.kind === "directory" || i.kind === "file" || i.kind === "unit") && existsSync(where(i.target))) chmodSync(where(i.target), parseInt(i.mode, 8));
  const request = (): UninstallRequest => ({
    version: 1,
    runnerUid: UID,
    runnerUser: "alice",
    actions: buildUninstallActions(plan, { user: "alice" }).map((a) => ("path" in a ? { ...a, path: where(a.path) } : a)),
  });
  return { where, request, snapshots, inside };
}
const mapped = (S: string): string[] => plan.createList.filter((i) => i.kind === "directory" || i.kind === "file" || i.kind === "unit").map((i) => path.join(S, i.target));

describe("applying the uninstall", () => {
  it("removes everything install made, stops the unit first, drops the membership and the group, and leaves snapshot_dir alone", async () => {
    const S = scratch();
    const L = lay(S);
    const f = fakeOps();
    const report = await applyUninstall(L.request(), f.ops);
    expect(report).toMatchObject({ ok: true, left: [] });
    for (const p of mapped(S)) expect(existsSync(p), p).toBe(false);
    expect(f.mutating()).toEqual(["systemctl disable --now fx-vmhelper.service", "systemctl daemon-reload", "gpasswd -d alice fx-vmhelper", "groupdel -- fx-vmhelper"]);
    expect(readFileSync(path.join(L.snapshots, "vm1.snap"), "utf8")).toBe("the person's data\n");
    expect(readdirSync(path.join(S, "home/alice")).sort()).toEqual(["snapshots"]);
  });

  it("keeps the snapshot directory install made when snapshots are in it, with its content, says so, and removes it when it is empty or absent", async () => {
    const S = scratch();
    const L = lay(S);
    const kept = L.where(LAYOUT.snapshotDir);
    writeFileSync(path.join(kept, "vm1.mem"), "guest memory\n");
    const report = await applyUninstall(L.request(), fakeOps().ops);
    expect(readFileSync(path.join(kept, "vm1.mem"), "utf8")).toBe("guest memory\n");
    expect(report.left.join("\n")).toContain(kept);
    expect(report.left.join("\n")).toContain("not empty");
    for (const p of mapped(S)) if (p !== kept) expect(existsSync(p), p).toBe(false);
    // the same dir, emptied by hand: a re-run removes it
    rmSync(path.join(kept, "vm1.mem"));
    const again = await applyUninstall(L.request(), fakeOps().ops);
    expect(again.ok).toBe(true);
    expect(again.done.join("\n")).toContain(kept);
    expect(existsSync(kept)).toBe(false);
  });

  it("a second run on the same host removes nothing and makes no change call but the (idempotent) reload", async () => {
    const S = scratch();
    const L = lay(S);
    const f = fakeOps();
    await applyUninstall(L.request(), f.ops);
    f.calls.length = 0;
    const again = await applyUninstall(L.request(), f.ops);
    expect(again).toMatchObject({ ok: true, left: [] });
    expect(again.done).toEqual(["systemctl daemon-reload"]);
    expect(f.mutating()).toEqual(["systemctl daemon-reload"]);
  });

  it("a run killed between the unit's removal and the reload reloads on its re-run, and finishes the rest", async () => {
    const S = scratch();
    const L = lay(S);
    const first = fakeOps({ failOn: "systemctl daemon-reload" });
    const broke = await applyUninstall(L.request(), first.ops);
    expect(broke.ok).toBe(false);
    expect(broke.failed).toMatch(/daemon-reload/);
    expect(existsSync(L.where(LAYOUT.unitFile))).toBe(false);
    expect(existsSync(L.where(LAYOUT.configFile))).toBe(true);
    const second = fakeOps({ active: false });
    const done = await applyUninstall(L.request(), second.ops);
    expect(done).toMatchObject({ ok: true, left: [] });
    // everything before the reload was already gone, yet systemd is told
    expect(second.mutating()[0]).toBe("systemctl daemon-reload");
    for (const p of mapped(S)) expect(existsSync(p), p).toBe(false);
  });

  it("a run killed after the group was removed finds nothing left to do for the group, and still removes the record last", async () => {
    const S = scratch();
    const L = lay(S);
    // dies at the record's own step: the group and membership are already gone
    const f = fakeOps();
    const early = { ...L.request(), actions: L.request().actions.slice(0, -2) };
    await applyUninstall(early, f.ops);
    expect(existsSync(L.where(LAYOUT.recordFile))).toBe(true);
    const done = await applyUninstall(L.request(), fakeOps({ active: false, noGroup: true }).ops);
    expect(done).toMatchObject({ ok: true, left: [] });
    expect(existsSync(L.where(LAYOUT.configDir))).toBe(false);
  });

  it("a file whose mode was changed is left in place and named; the rest of the list still goes, and the directory holding it stays", async () => {
    const S = scratch();
    const L = lay(S);
    chmodSync(L.where(LAYOUT.configFile), 0o666);
    const report = await applyUninstall(L.request(), fakeOps().ops);
    expect(report.ok).toBe(true);
    expect(report.left).toHaveLength(2);
    expect(report.left[0]).toContain(`${L.where(LAYOUT.configFile)}: its owner or mode is not what install sets (root:root 0600)`);
    expect(report.left[1]).toContain("is not empty");
    expect(lstatSync(L.where(LAYOUT.configFile)).mode & 0o777).toBe(0o666);
    expect(existsSync(L.where(LAYOUT.unitFile))).toBe(false);
    expect(existsSync(L.where(LAYOUT.helperDir))).toBe(false);
  });

  it("a file or directory with another owner than install sets is left in place: nothing owned by anyone else is removed", async () => {
    const S = scratch();
    const L = lay(S);
    const report = await applyUninstall(L.request(), fakeOps({ ownerUid: UID + 1 }).ops);
    expect(report.ok).toBe(true);
    expect(report.left.filter((l) => l.startsWith(S)).map((l) => l.split(":")[0]).sort()).toEqual(mapped(S).sort());
    // and with root's owner in doubt the record is not believed either, so the group and the membership stay
    expect(report.left.filter((l) => !l.startsWith(S))).toHaveLength(2);
    for (const p of mapped(S)) expect(existsSync(p), p).toBe(true);
    expect(existsSync(path.join(L.where(LAYOUT.helperDir), "bin/fx-vmhelper"))).toBe(true);
  });

  it("a directory whose mode was changed is left with everything in it", async () => {
    const S = scratch();
    const L = lay(S);
    chmodSync(L.where(LAYOUT.helperDir), 0o775);
    const report = await applyUninstall(L.request(), fakeOps().ops);
    expect(report.left).toHaveLength(1);
    expect(report.left[0]).toContain(L.where(LAYOUT.helperDir));
    expect(existsSync(path.join(L.where(LAYOUT.helperDir), "bin/fx-vmhelper"))).toBe(true);
  });

  it("a directory where a file should be, or a file where a directory should be, is left and named", async () => {
    const S = scratch();
    const L = lay(S);
    rmSync(L.where(LAYOUT.configFile));
    mkdirSync(L.where(LAYOUT.configFile));
    rmSync(L.where(LAYOUT.jailRoot), { recursive: true });
    writeFileSync(L.where(LAYOUT.jailRoot), "not a directory\n");
    const report = await applyUninstall(L.request(), fakeOps().ops);
    expect(report.left.find((l) => l.startsWith(L.where(LAYOUT.configFile)))).toContain("it is not a regular file");
    expect(report.left.find((l) => l.startsWith(L.where(LAYOUT.jailRoot)))).toContain("it is not a directory");
    expect(existsSync(L.where(LAYOUT.configFile))).toBe(true);
    expect(existsSync(L.where(LAYOUT.jailRoot))).toBe(true);
  });

  it("a tree with a symlink, a FIFO or a file others can write inside is left whole: not one file of it is removed", async () => {
    for (const bad of ["link", "fifo", "writable"]) {
      const S = scratch();
      const L = lay(S);
      if (bad === "link") symlinkSync(L.snapshots, path.join(L.where(LAYOUT.helperDir), "bin/escape"));
      else if (bad === "fifo") execFileSync("mkfifo", [path.join(L.where(LAYOUT.helperDir), "bin/pipe")]);
      else chmodSync(path.join(L.where(LAYOUT.helperDir), "bin/fx-vmhelper"), 0o777);
      const report = await applyUninstall(L.request(), fakeOps().ops);
      expect(report.left, bad).toHaveLength(1);
      expect(report.left[0], bad).toContain(bad === "writable" ? "writable by others" : "not a plain file or directory");
      expect(existsSync(path.join(L.where(LAYOUT.helperDir), "templates/fx-agent/rootfs")), bad).toBe(true);
      expect(readFileSync(path.join(L.snapshots, "vm1.snap"), "utf8"), bad).toBe("the person's data\n");
    }
  });

  it("a tree entry of another owner, or on another device, leaves the tree whole (the stat is injected: making either takes root)", async () => {
    const real = (f: string): Stats => lstatSync(f);
    const lie = (st: Stats, over: Partial<Stats>): Stats => Object.create(st, Object.fromEntries(Object.entries(over).map(([k, v]) => [k, { value: v }]))) as Stats;
    for (const [what, over] of [["owner", { uid: UID + 1 }], ["device", { dev: 1 }]] as const) {
      const S = scratch();
      const L = lay(S);
      const victim = path.join(L.where(LAYOUT.helperDir), "bin/fx-vmhelper");
      const report = await applyUninstall(L.request(), fakeOps().ops, { lstat: (f) => (f === victim ? lie(real(f), over) : real(f)) });
      expect(report.left, what).toHaveLength(1);
      expect(report.left[0], what).toContain("a different owner");
      expect(existsSync(victim), what).toBe(true);
    }
  });

  it("snapshot_dir is never touched, even when it lies inside the jail root: the jail root is not removed with what is in it", async () => {
    const S = scratch();
    const L = lay(S);
    const inJail = path.join(L.where(LAYOUT.jailRoot), "snapshots");
    mkdirSync(inJail);
    writeFileSync(path.join(inJail, "vm2.snap"), "more data\n");
    const report = await applyUninstall(L.request(), fakeOps().ops);
    expect(report.left).toEqual([expect.stringContaining(`${L.where(LAYOUT.jailRoot)}: it is not empty`)]);
    expect(readFileSync(path.join(inJail, "vm2.snap"), "utf8")).toBe("more data\n");
    expect(readFileSync(path.join(L.snapshots, "vm1.snap"), "utf8")).toBe("the person's data\n");
  });

  it("does not stop a unit that is neither enabled nor running, and a failing stop ends the run before anything is removed", async () => {
    const S = scratch();
    const L = lay(S);
    const idle = fakeOps({ active: false });
    await applyUninstall(L.request(), idle.ops);
    expect(idle.mutating().some((c) => c.startsWith("systemctl disable"))).toBe(false);
    const S2 = scratch();
    const L2 = lay(S2);
    const stuck = await applyUninstall(L2.request(), fakeOps({ failOn: "systemctl disable" }).ops);
    expect(stuck.ok).toBe(false);
    expect(stuck.failed).toContain("systemctl disable --now fx-vmhelper.service");
    for (const p of mapped(S2)) expect(existsSync(p), p).toBe(true);
  });

  it("a link on the way to any target means no step runs at all: not even the service is stopped", async () => {
    const S = scratch();
    const L = lay(S);
    const real = path.join(S, "elsewhere");
    mkdirSync(real);
    writeFileSync(path.join(real, "config.json"), "x\n", { mode: 0o600 });
    rmSync(L.where(LAYOUT.configFile));
    rmSync(L.where(LAYOUT.recordFile));
    rmSync(L.where(LAYOUT.configDir), { recursive: true });
    symlinkSync(real, L.where(LAYOUT.configDir));
    const f = fakeOps();
    const report = await applyUninstall(L.request(), f.ops);
    expect(report.ok).toBe(false);
    expect(report.failed).toMatch(/is a symlink.*nothing was changed/);
    expect(report.done).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(existsSync(L.where(LAYOUT.helperDir))).toBe(true);
    expect(existsSync(path.join(L.where("/var/lib/fx-vmhelper"), "registry.json"))).toBe(true);
    expect(readFileSync(path.join(real, "config.json"), "utf8")).toBe("x\n");
  });

  it("an install record that is not root's (another owner, another mode, a second link) counts as no record at all", async () => {
    for (const spoil of ["mode", "link"]) {
      const S = scratch();
      const L = lay(S);
      if (spoil === "mode") chmodSync(L.where(LAYOUT.recordFile), 0o644);
      else linkSync(L.where(LAYOUT.recordFile), path.join(S, "second-name"));
      const f = fakeOps();
      const report = await applyUninstall(L.request(), f.ops);
      expect(f.mutating().filter((c) => /gpasswd|groupdel/.test(c)), spoil).toEqual([]);
      expect(report.left.join("\n"), spoil).toContain("install did not record making");
    }
    const S = scratch();
    const L = lay(S);
    const f = fakeOps({ ownerUid: UID + 1 });
    await applyUninstall(L.request(), f.ops);
    expect(f.mutating().filter((c) => /gpasswd|groupdel/.test(c))).toEqual([]);
  });

  it("the group and the membership go only if install's record says it made them", async () => {
    const cases: Array<[string, { group_created: boolean; members_added: string[] } | null, string[], number]> = [
      ["no record at all", null, [], 2],
      ["the group was there before, the membership was added", { group_created: false, members_added: ["alice"] }, ["gpasswd -d alice fx-vmhelper"], 1],
      ["the group was made, the user was a member already", { group_created: true, members_added: [] }, ["groupdel -- fx-vmhelper"], 1],
      ["someone else's membership was recorded", { group_created: false, members_added: ["bob"] }, [], 2],
    ];
    for (const [what, record, changes, lefts] of cases) {
      const S = scratch();
      const L = lay(S, record);
      const f = fakeOps();
      const report = await applyUninstall(L.request(), f.ops);
      expect(f.mutating().filter((c) => /gpasswd|groupdel/.test(c)), what).toEqual(changes);
      expect(report.left, what).toHaveLength(lefts);
      if (lefts > 0) expect(report.left.join("\n"), what).toContain("install did not record making");
      // the group and the user's place in it are still there when not recorded
      expect(f.groups.has(HELPER_GROUP), what).toBe(!changes.includes("groupdel -- fx-vmhelper"));
    }
  });
});

function fakeHost(opts: { existing?: readonly string[] | "all"; reply?: { code: number | null; stdout: string }; confirm?: boolean; refusal?: string } = {}) {
  const rootCalls: UninstallRequest[] = [];
  const asked: string[] = [];
  const host: UninstallHost = {
    facts: async (paths) => ({ runner: { user: "alice", uid: 1000 }, existing: opts.existing === "all" ? paths : (opts.existing ?? []) }),
    hostRefusal: () => opts.refusal,
    root: {
      run: async (request) => {
        rootCalls.push(request);
        return opts.reply ?? { code: 0, stdout: `${JSON.stringify({ ok: true, done: ["a"], unchanged: [], left: [] })}\n` };
      },
    },
    confirm: async (q) => {
      asked.push(q);
      return opts.confirm ?? true;
    },
  };
  return { host, rootCalls, asked };
}
const run = async (args: string[], host: UninstallHost): Promise<{ code: number; text: string }> => {
  let text = "";
  const code = await uninstallCommand(args, host, (l) => (text += `${l}\n`));
  return { code, text };
};

describe("fx-runner vm uninstall", () => {
  it("on a clean host says Not installed, exits 0, asks nothing and makes no root call, with or without --dry-run, any number of times", async () => {
    const w = fakeHost();
    for (const args of [[], ["--dry-run"], ["--yes"], []]) {
      const r = await run(args, w.host);
      expect(r).toEqual({ code: 0, text: "Not installed: nothing to remove.\n" });
    }
    expect(w.rootCalls).toHaveLength(0);
    expect(w.asked).toEqual([]);
  });

  it("--dry-run prints the whole removal list and the exact root steps and makes zero root calls and asks nothing", async () => {
    const w = fakeHost({ existing: "all" });
    const r = await run(["--dry-run"], w.host);
    expect(r.code).toBe(0);
    expect(w.rootCalls).toHaveLength(0);
    expect(w.asked).toEqual([]);
    for (const part of ["stop and disable fx-vmhelper.service\n  release          the sandbox uid and gid ranges named in the config", "remove file      /etc/fx-vmhelper/config.json  root:root 0600", "Root steps, in order", "remove directory /opt/fx-vmhelper  (only if it is root:root 0755, with what is in it", "Not touched: sandbox data. The snapshot directory install made is removed only if it is empty", "WARNING: stopping the helper stops every sandbox that is running", "no root call was made"]) expect(r.text).toContain(part);
    expect(r.text).not.toMatch(/null|undefined/);
  });

  it("asks once, says that running sandboxes will be stopped, and makes exactly one root call with a request the root side accepts; --yes asks nothing", async () => {
    const a = fakeHost({ existing: "all" });
    expect((await run([], a.host)).code).toBe(0);
    expect(a.asked).toHaveLength(1);
    expect(a.asked[0]).toContain("Running sandboxes will be stopped");
    expect(a.rootCalls).toHaveLength(1);
    expect(a.rootCalls[0]).toMatchObject({ version: 1, runnerUid: 1000, runnerUser: "alice" });
    expect(checkUninstallRequest(a.rootCalls[0], 0).actions).toHaveLength(13);
    const b = fakeHost({ existing: "all" });
    expect((await run(["--yes"], b.host)).text).toContain("Uninstalled. No sandbox data was touched.");
    expect(b.asked).toEqual([]);
    expect(b.rootCalls).toHaveLength(1);
  });

  it("a partly installed host (only the record left) is still uninstalled; a declined confirmation makes no root call", async () => {
    const w = fakeHost({ existing: [LAYOUT.recordFile], confirm: false });
    expect(await run([], w.host)).toMatchObject({ code: 1, text: expect.stringContaining("Cancelled: nothing was changed.") });
    expect(w.rootCalls).toHaveLength(0);
  });

  it("refuses before any root call, in one sentence that names the NixOS module, when the host says it is declaratively managed; dry run and --yes alike", async () => {
    for (const args of [[], ["--yes"], ["--dry-run"]]) {
      const w = fakeHost({ existing: "all", refusal: "vm uninstall cannot run here (this is a NixOS machine); use the NixOS module services.fx-vmhelper instead." });
      await expect(run(args, w.host)).rejects.toThrow(/services\.fx-vmhelper/);
      expect(w.rootCalls).toHaveLength(0);
      expect(w.asked).toEqual([]);
    }
  });

  it("the real host check, on a made-up root, refuses on NixOS and on a link above a target, and passes a plain host", () => {
    const list = uninstallPathActions(buildUninstallActions(plan, { user: "alice" }));
    const check = (root: string): string | undefined => hostRefusal(list, root, "vm uninstall");
    const plain = scratch();
    expect(check(plain)).toBeUndefined();
    const nixos = scratch();
    mkdirSync(path.join(nixos, "etc"));
    writeFileSync(path.join(nixos, "etc/NIXOS"), "");
    expect(check(nixos)).toMatch(/^vm uninstall cannot run here \(this is a NixOS machine\); use the NixOS module services\.fx-vmhelper instead\.$/);
    const linked = scratch();
    mkdirSync(path.join(linked, "etc/systemd"), { recursive: true });
    mkdirSync(path.join(linked, "store"));
    symlinkSync(path.join(linked, "store"), path.join(linked, "etc/systemd/system"));
    expect(check(linked)).toMatch(/^vm uninstall cannot run here \(.*etc\/systemd\/system is a symlink\)/);
  });

  it("names what was left in place, says why, and exits 1; a failed step is reported with what to do", async () => {
    const left = { ok: true, done: ["x"], unchanged: ["y"], left: ["/etc/fx-vmhelper/config.json: its owner or mode is not what install sets"] };
    const a = await run(["--yes"], fakeHost({ existing: "all", reply: { code: 1, stdout: `${JSON.stringify(left)}\n` } }).host);
    expect(a.code).toBe(1);
    expect(a.text).toContain("LEFT IN PLACE, not as install made it");
    expect(a.text).toContain("  /etc/fx-vmhelper/config.json: its owner or mode");
    expect(a.text).toContain("Uninstalled, except for what is listed above.");
    const b = await run(["--yes"], fakeHost({ existing: "all", reply: { code: 1, stdout: `${JSON.stringify({ ok: false, done: [], unchanged: [], left: [], failed: "boom" })}\n` } }).host);
    expect(b.code).toBe(1);
    expect(b.text).toContain("Failed: boom. Nothing after it was touched; run the same command again");
  });

  it("no report from the root side is an error, and unknown or repeated options are refused with the usage line", async () => {
    await expect(run(["--yes"], fakeHost({ existing: "all", reply: { code: 1, stdout: "" } }).host)).rejects.toThrow(/did not run \(exit 1\)/);
    for (const args of [["--force"], ["--yes", "--yes"], ["x"]]) await expect(run(args, fakeHost().host)).rejects.toThrow(UNINSTALL_USAGE);
  });

  const good = { version: 1, runnerUid: UID, runnerUser: "alice", actions: buildUninstallActions(plan, { user: "alice" }) };
  const side = (euid: number, stdin: string, f = fakeOps(), sudoUid: string | null = String(UID)) => ({ euid, sudoUid: sudoUid ?? undefined, readStdin: async () => stdin, ops: f.ops });

  it("the root side reads its request from standard input, refuses anything but root and anything but the uninstall list, and runs nothing for a refused request", async () => {
    const f = fakeOps();
    let out = "";
    await expect(rootRemoveCommand(side(1000, JSON.stringify(good), f), () => undefined)).rejects.toThrow(/must run as root/);
    await expect(rootRemoveCommand(side(0, "not json", f), () => undefined)).rejects.toThrow(/not JSON/);
    await expect(rootRemoveCommand(side(0, JSON.stringify({ ...good, actions: [{ op: "remove-dir", path: "/etc", owner: "root:root", mode: "0755", tree: true }] }), f), (l) => (out += l))).rejects.toThrow(/not the uninstall list/);
    expect(out).toBe("");
    expect(f.calls).toEqual([]);
  });

  it("the root side believes the runner only if it is the user who ran sudo and the account database agrees: a request for another user is refused", async () => {
    const f = fakeOps();
    await expect(rootRemoveCommand(side(0, JSON.stringify(good), f, null), () => undefined)).rejects.toThrow(/not the user who ran sudo/);
    await expect(rootRemoveCommand(side(0, JSON.stringify(good), f, String(UID + 1)), () => undefined)).rejects.toThrow(/not the user who ran sudo/);
    // a request built for "bob" by a caller who is alice (sudo's uid is alice's, the database says bob is another uid)
    const bob = { ...good, runnerUser: "bob", actions: buildUninstallActions(uninstallPlan("bob"), { user: "bob" }) };
    const db: Pick<RootOps, "run"> = { run: async (_f, args) => ({ code: 0, output: `${args[1]}:x:${args[1] === "bob" ? UID + 7 : UID}:${GID}::/:/bin/sh\n` }) };
    await expect(rootRemoveCommand({ euid: 0, sudoUid: String(UID), readStdin: async () => JSON.stringify(bob), ops: db }, () => undefined)).rejects.toThrow(/do not match the account database/);
    const unknown: Pick<RootOps, "run"> = { run: async () => ({ code: 2, output: "" }) };
    await expect(rootRemoveCommand({ euid: 0, sudoUid: String(UID), readStdin: async () => JSON.stringify(good), ops: unknown }, () => undefined)).rejects.toThrow(/do not match the account database/);
    expect(f.calls).toEqual([]);
  });

  it("vm root-remove runs its programs through the host's fixed-PATH runner: no LD_* and no inherited search path", async () => {
    const hosts = createVmInstallHosts({ selfCommand: ["/x"], tuf: {}, confirm: async () => false, buildRootArgv, buildRemoveArgv, hostRefusal, hostRefusalRemove: () => undefined });
    const saved = { ld: process.env.LD_LIBRARY_PATH, pre: process.env.LD_PRELOAD };
    process.env.LD_LIBRARY_PATH = "/nonexistent-lib";
    process.env.LD_PRELOAD = "/nonexistent.so";
    const seen: string[] = [];
    try {
      // the first thing the root side asks is `getent passwd <runner>`; the answer here disagrees with the request, so the request is refused right
      // after the environment is captured and `applyUninstall` never runs (this request names the real install places, which no test may touch)
      const real = hosts.root.ops;
      const ops = { run: async (file: string, args: readonly string[]) => (file === "getent" ? (seen.push((await real.run("/usr/bin/env", [])).output), { code: 0, output: `${args[1]}:x:${UID + 99}:${GID}::/:/bin/sh\n` }) : { code: 1, output: "" }) };
      const out: string[] = [];
      await expect(vmCommand(["root-remove"], {} as never, (l) => out.push(l), { root: { ...hosts.root, euid: 0, sudoUid: String(UID), readStdin: async () => JSON.stringify(good), ops } })).rejects.toThrow(/do not match the account database/);
      expect(out).toEqual([]);
    } finally {
      if (saved.ld === undefined) delete process.env.LD_LIBRARY_PATH;
      else process.env.LD_LIBRARY_PATH = saved.ld;
      if (saved.pre === undefined) delete process.env.LD_PRELOAD;
      else process.env.LD_PRELOAD = saved.pre;
    }
    expect(seen[0]!.trim().split("\n")).toEqual([`PATH=${ROOT_PATH}`]);
    // and the host that vmCommand hands root-remove is the same object the install side's root-apply uses
    expect(typeof hosts.uninstall.root.run).toBe("function");
  });
});
