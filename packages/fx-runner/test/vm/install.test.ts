import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../../src/cliError.js";
import { TufClient } from "../../src/update/tuf.js";
import { probeHelper } from "../../src/vm/helperProbe.js";
import { INSTALL_USAGE, buildRootArgv, installCommand, rootApplyCommand, type InstallHost } from "../../src/vm/install.js";
import { HELPER_GROUP, LAYOUT, buildInstallPlan, type HostFacts } from "../../src/vm/installPlan.js";
import { UNIT_NAME, buildRootActions, checkRequest, describeAction, type RootAction, type RootRequest } from "../../src/vm/rootActions.js";
import { applyRootActions, fsCalls, hostRefusal, type RootOps } from "../../src/vm/rootApply.js";
import { ROOT_PATH, createVmInstallHosts } from "../../scripts/vm-install-host.mjs";
import { socketPath } from "../../src/vm/unitRender.js";

/** D#587 B-2a-2 PR-3: the root phase. Nothing here calls sudo, systemctl or any real account program: the root executor and the program runner are fakes. */
const UID = process.getuid!();
const GID = process.getgid!();
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});
const scratch = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "fx-install-test-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

const FACTS: Omit<HostFacts, "smallestTemplateRamMb"> = {
  cpus: 8,
  memTotalKb: 16 * 1024 * 1024,
  runner: { user: "alice", uid: 1000, gid: 1000 },
  takenUids: [{ first: 0, count: 1001 }],
  takenGids: [{ first: 0, count: 1001 }],
};

/** A bundle as stageBundle returns it, with files that really exist in a fresh directory. */
function fixtureBundle(dir: string) {
  const file = (name: string, content: string, dest: string) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content, { mode: 0o600 });
    return { file: path.join(dir, name), sha256: sha(content), length: content.length, dest };
  };
  const manifest = `{"fx-agent":{"kernel":"${sha("kernel")}","rootfs":"${sha("rootfs")}"}}\n`;
  return {
    dir,
    arch: "amd64" as const,
    binaries: { vmhelper: file("vmhelper", "vmhelper", LAYOUT.helperBinary), jailer: file("jailer", "jailer", LAYOUT.jailerBinary), firecracker: file("firecracker", "firecracker", LAYOUT.firecrackerBinary) },
    templates: { "fx-agent": { kernel: file("t/kernel", "kernel", `${LAYOUT.templateDir}/fx-agent/kernel`), rootfs: file("t/rootfs", "rootfs", `${LAYOUT.templateDir}/fx-agent/rootfs`) } },
    manifest: { file: path.join(dir, "m.json"), text: manifest, dest: LAYOUT.templateManifest },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("the root actions", () => {
  const plan = buildInstallPlan({ ...FACTS, smallestTemplateRamMb: 512 });
  const staged = fixtureBundle(scratch());
  const actions = buildRootActions(plan, staged, FACTS.runner, sha);
  const short = (a: RootAction): string => (a.op === "mkdir" || a.op === "install" ? `${a.op} ${a.path} ${a.owner} ${a.mode}` : a.op === "member" ? `member ${a.user} ${a.group}` : a.op === "group" ? `group ${a.name}` : a.op === "enable-start" || a.op === "restart" ? `${a.op} ${a.unit}` : a.op === "probe" ? `probe ${a.socket}` : a.op);

  it("is exactly the create list's own places plus the staged installs, in one fixed order", () => {
    expect(actions.map(short)).toEqual([
      `group ${HELPER_GROUP}`,
      `member alice ${HELPER_GROUP}`,
      "mkdir /opt/fx-vmhelper root:root 0755",
      "mkdir /opt/fx-vmhelper/bin root:root 0755",
      "mkdir /opt/fx-vmhelper/templates root:root 0755",
      "mkdir /opt/fx-vmhelper/templates/fx-agent root:root 0755",
      "mkdir /etc/fx-vmhelper root:root 0755",
      "mkdir /var/lib/fx-vm root:root 0711",
      "mkdir /var/lib/fx-vm-snapshots root:root 0700",
      "install /opt/fx-vmhelper/bin/fx-vmhelper root:root 0755",
      "install /opt/fx-vmhelper/bin/jailer root:root 0755",
      "install /opt/fx-vmhelper/bin/firecracker root:root 0755",
      "install /opt/fx-vmhelper/template-manifest.json root:root 0644",
      "install /opt/fx-vmhelper/templates/fx-agent/kernel root:root 0644",
      "install /opt/fx-vmhelper/templates/fx-agent/rootfs root:root 0644",
      "install /etc/fx-vmhelper/config.json root:root 0600",
      "install /etc/systemd/system/fx-vmhelper.service root:root 0644",
      "daemon-reload",
      `enable-start ${UNIT_NAME}`,
      `restart ${UNIT_NAME}`,
      `probe ${socketPath()}`,
    ]);
    expect(describeAction(actions[15]!)).toContain(`sha256 ${sha(plan.config.text).slice(0, 12)}`);
  });

  it("passes the root side's own check, and every refusal is a CliError with exit 2", () => {
    const req: RootRequest = { version: 1, runnerUid: 1000, runnerUser: "alice", actions };
    expect(checkRequest(req, 0)).toBe(req);
    const refuse = (r: unknown, euid = 0): void => expect(() => checkRequest(r, euid)).toThrow(CliError);
    refuse(req, 1000);
    refuse({ ...req, runnerUid: 0 });
    refuse({ ...req, actions: [{ op: "mkdir", path: "/etc/passwd.d", owner: "root:root", mode: "0755" }] });
    refuse({ ...req, actions: [{ op: "mkdir", path: "/opt/fx-vmhelper/../x", owner: "root:root", mode: "0755" }] });
    refuse({ ...req, actions: [{ op: "mkdir", path: "opt/fx-vmhelper", owner: "root:root", mode: "0755" }] });
    refuse({ ...req, actions: [{ op: "group", name: "wheel" }] });
    refuse({ ...req, actions: [{ op: "member", user: "bob", group: HELPER_GROUP }] });
    refuse({ ...req, actions: [{ op: "enable-start", unit: "sshd.service" }] });
    refuse({ ...req, actions: [{ op: "run", argv: ["sh"] }] });
  });

  it("accepts the snapshot directory only as root:root 0700: any other mode or owner is refused, and no sibling path is let in", () => {
    const req = (a: object): unknown => ({ version: 1, runnerUid: 1000, runnerUser: "alice", actions: [a] });
    const snap = "/var/lib/fx-vm-snapshots";
    expect(() => checkRequest(req({ op: "mkdir", path: snap, owner: "root:root", mode: "0700" }), 0)).not.toThrow();
    for (const mode of ["0755", "0711", "0750", "0701", "0777", "0000"]) expect(() => checkRequest(req({ op: "mkdir", path: snap, owner: "root:root", mode }), 0), mode).toThrow(CliError);
    for (const owner of ["alice:alice", "root:fx-vmhelper", "alice:root", "root:wheel"]) expect(() => checkRequest(req({ op: "mkdir", path: snap, owner, mode: "0700" }), 0), owner).toThrow(CliError);
    for (const mode of ["4700", "2700", "1700"]) expect(() => checkRequest(req({ op: "mkdir", path: snap, owner: "root:root", mode }), 0), mode).toThrow(CliError);
    // exactly that path: neither a child, a sibling with the same prefix, nor a file installed there
    for (const p of [`${snap}/x`, `${snap}2`, "/var/lib/fx-vm-snapshot", "/var/lib"]) expect(() => checkRequest(req({ op: "mkdir", path: p, owner: "root:root", mode: "0700" }), 0), p).toThrow(CliError);
    expect(() => checkRequest(req({ op: "install", path: snap, owner: "root:root", mode: "0600", sha256: "0".repeat(64), length: 0, text: "" }), 0)).toThrow(CliError);
  });

  it("builds the one fixed root argument list, with nothing from the plan in it", () => {
    expect(buildRootArgv("/usr/bin/sudo", ["/usr/bin/node", "/x/fx-runner.mjs"])).toEqual(["/usr/bin/sudo", "--", "/usr/bin/node", "/x/fx-runner.mjs", "vm", "root-apply"]);
  });
});

/** Programs the root side starts, faked: accounts and units live in a map, and a call can be made to fail. */
function fakeOps(opts: { failOn?: string; running?: boolean; enabled?: boolean; active?: boolean; probeFails?: boolean } = {}) {
  const calls: string[] = [];
  const sys = { enabled: opts.running === true || opts.enabled === true, active: opts.running === true || opts.active === true };
  const groups = new Map<string, string[]>();
  const ops: RootOps = {
    run: async (file, args) => {
      const line = `${file} ${args.join(" ")}`;
      if (file === "getent") {
        if (args[0] === "passwd") return { code: 0, output: `${args[1]}:x:${UID}:${GID}::/:/bin/sh\n` };
        const members = groups.get(args[1]!);
        return args[1] === "root" || members !== undefined ? { code: 0, output: `${args[1]}:x:${GID}:${(members ?? []).join(",")}\n` } : { code: 2, output: "" };
      }
      calls.push(line);
      if (opts.failOn !== undefined && line.startsWith(opts.failOn)) return { code: 1, output: "" };
      if (file === "groupadd") groups.set(args.at(-1)!, []);
      if (file === "groupdel") groups.delete(args[0]!);
      if (file === "usermod") groups.get(args[1]!)?.push(args.at(-1)!);
      if (file === "gpasswd") groups.set(args[2]!, (groups.get(args[2]!) ?? []).filter((m) => m !== args[1]));
      if (file === "systemctl") {
        if (args[0] === "is-enabled") return { code: sys.enabled ? 0 : 1, output: "" };
        if (args[0] === "is-active") return { code: sys.active ? 0 : 1, output: "" };
        if (args[0] === "enable") sys.enabled = sys.active = true;
        if (args[0] === "stop") sys.active = false;
        if (args[0] === "disable") sys.enabled = false;
      }
      return { code: 0, output: "" };
    },
    probe: async () => opts.probeFails !== true,
  };
  return { ops, calls, groups, sys };
}

/** A request over a scratch directory: a group, a member, two directories, one staged and one carried file, the service. */
function scratchRequest(root: string, src: string): RootRequest {
  const text = "carried text\n";
  const staged = "staged bytes\n";
  writeFileSync(path.join(src, "staged"), staged, { mode: 0o600 });
  const o = { owner: "root:root" };
  return {
    version: 1,
    runnerUid: UID,
    runnerUser: "alice",
    actions: [
      { op: "group", name: HELPER_GROUP },
      { op: "member", user: "alice", group: HELPER_GROUP },
      { op: "mkdir", path: root, ...o, mode: "0755" },
      { op: "mkdir", path: `${root}/bin`, ...o, mode: "0700" },
      { op: "install", path: `${root}/bin/staged`, ...o, mode: "0755", sha256: sha(staged), length: staged.length, source: path.join(src, "staged") },
      { op: "install", path: `${root}/config`, ...o, mode: "0600", sha256: sha(text), length: text.length, text },
      { op: "enable-start", unit: UNIT_NAME },
      { op: "probe", socket: socketPath() },
    ],
  };
}

describe("applying the root actions", () => {
  it("makes everything with the stated owner and mode, and the second run changes nothing and says so", async () => {
    const root = path.join(scratch(), "opt");
    const f = fakeOps();
    const req = scratchRequest(root, scratch());
    const first = await applyRootActions(req, f.ops);
    expect(first).toMatchObject({ ok: true, undone: [], unchanged: [] });
    expect(first.done).toHaveLength(req.actions.length - 1);
    expect(lstatSync(`${root}/bin`).mode & 0o7777).toBe(0o700);
    expect(lstatSync(`${root}/bin/staged`).mode & 0o7777).toBe(0o755);
    expect(readFileSync(`${root}/config`, "utf8")).toBe("carried text\n");
    expect(readdirSync(`${root}/bin`)).toEqual(["staged"]);
    const callsBefore = f.calls.length;
    const second = await applyRootActions(req, f.ops);
    expect(second).toMatchObject({ ok: true, done: [], undone: [] });
    expect(second.unchanged).toHaveLength(req.actions.length - 1);
    expect(f.calls.slice(callsBefore).filter((c) => /groupadd|usermod|enable --now|daemon-reload/.test(c))).toEqual([]);
  });

  it("when a step fails, undoes exactly the steps that were done, last first, and leaves nothing behind", async () => {
    const root = path.join(scratch(), "opt");
    const f = fakeOps({ failOn: "systemctl enable" });
    const report = await applyRootActions(scratchRequest(root, scratch()), f.ops);
    expect(report.ok).toBe(false);
    expect(report.failed).toContain("systemctl enable --now");
    expect(report.done).toHaveLength(6);
    expect(report.undone).toEqual([...report.done].reverse());
    expect(report.undoFailed).toEqual([]);
    expect(f.calls.filter((c) => /^(groupdel|gpasswd)/.test(c))).toEqual([`gpasswd -d alice ${HELPER_GROUP}`, `groupdel ${HELPER_GROUP}`]);
    expect(existsSync(root)).toBe(false);
    expect(f.groups.size).toBe(0);
  });

  it("puts a replaced file back on a failure, and keeps no copy of it after a success", async () => {
    const root = path.join(scratch(), "opt");
    const src = scratch();
    const req = scratchRequest(root, src);
    mkdirSync(root, { mode: 0o755 });
    mkdirSync(`${root}/bin`, { mode: 0o700 });
    writeFileSync(`${root}/config`, "old contents\n", { mode: 0o600 });
    const bad = await applyRootActions(req, fakeOps({ failOn: "systemctl enable" }).ops);
    expect(bad.ok).toBe(false);
    expect(readFileSync(`${root}/config`, "utf8")).toBe("old contents\n");
    expect(readdirSync(root).sort()).toEqual(["bin", "config"]);
    const good = await applyRootActions(req, fakeOps().ops);
    expect(good.ok).toBe(true);
    expect(readFileSync(`${root}/config`, "utf8")).toBe("carried text\n");
    expect(readdirSync(root).sort()).toEqual(["bin", "config"]);
  });

  /** The scratch request with its program file marked and a restart step before the probe, as buildRootActions makes them. */
  const upgradeRequest = (root: string, src: string): RootRequest => {
    const req = scratchRequest(root, src);
    const actions = req.actions.map((a) => (a.op === "install" && a.path.endsWith("/config") ? { ...a, restarts: true as const } : a));
    actions.splice(actions.length - 1, 0, { op: "restart", unit: UNIT_NAME });
    return { ...req, actions };
  };
  const withNewConfig = (req: RootRequest, text: string): RootRequest => ({ ...req, actions: req.actions.map((a) => (a.op === "install" && a.path.endsWith("/config") ? { ...a, text, sha256: sha(text), length: text.length } : a)) });

  it("restarts a running helper when a re-run changed its program, config or unit, and not when nothing changed", async () => {
    const root = path.join(scratch(), "opt");
    const req = upgradeRequest(root, scratch());
    const fresh = fakeOps();
    expect((await applyRootActions(req, fresh.ops)).ok).toBe(true);
    // a fresh install starts the service and does not restart it
    expect(fresh.calls.filter((c) => c.startsWith("systemctl restart"))).toEqual([]);
    const same = fakeOps({ running: true });
    expect((await applyRootActions(req, same.ops)).done.filter((d) => /install|make directory/.test(d))).toEqual([]);
    expect(same.calls.filter((c) => c.startsWith("systemctl restart"))).toEqual([]);
    const changed = fakeOps({ running: true });
    const r = await applyRootActions(withNewConfig(req, "new config\n"), changed.ops);
    expect(r.ok).toBe(true);
    expect(changed.calls.filter((c) => c.startsWith("systemctl restart"))).toEqual([`systemctl restart ${UNIT_NAME}`]);
    expect(readFileSync(`${root}/config`, "utf8")).toBe("new config\n");
  });

  it("a failed restart puts the old files back and restarts again", async () => {
    const root = path.join(scratch(), "opt");
    const req = upgradeRequest(root, scratch());
    expect((await applyRootActions(req, fakeOps().ops)).ok).toBe(true);
    const f = fakeOps({ running: true });
    let restarts = 0;
    const run = f.ops.run;
    f.ops.run = async (file, args) => (file === "systemctl" && args[0] === "restart" && ++restarts === 1 ? { code: 1, output: "" } : run(file, args));
    const r = await applyRootActions(withNewConfig(req, "new config\n"), f.ops);
    expect(r.ok).toBe(false);
    expect(r.failed).toContain("systemctl restart");
    expect(readFileSync(`${root}/config`, "utf8")).toBe("carried text\n");
    expect(restarts).toBe(2);
    expect(r.undone.at(-1)).toContain("restart again");
    expect(r.undoFailed).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(["bin", "config"]);
  });

  it("refuses a symlink at a target path, or above it, and changes nothing", async () => {
    const parent = scratch();
    const root = path.join(parent, "opt");
    const elsewhere = scratch();
    // the target file is a link to a file elsewhere
    mkdirSync(root, { mode: 0o755 });
    mkdirSync(`${root}/bin`, { mode: 0o700 });
    writeFileSync(path.join(elsewhere, "victim"), "keep me\n");
    symlinkSync(path.join(elsewhere, "victim"), `${root}/config`);
    const atTarget = await applyRootActions(scratchRequest(root, scratch()), fakeOps().ops);
    expect(atTarget.ok).toBe(false);
    expect(atTarget.failed).toMatch(/not a regular file|symlink/);
    expect(readFileSync(path.join(elsewhere, "victim"), "utf8")).toBe("keep me\n");
    // a directory above the target is a link
    const linked = path.join(parent, "linked");
    symlinkSync(elsewhere, linked);
    const above = await applyRootActions(scratchRequest(path.join(linked, "opt"), scratch()), fakeOps().ops);
    expect(above.ok).toBe(false);
    expect(above.failed).toContain("is a symlink");
    expect(above).toMatchObject({ done: [], undone: [] });
    expect(readdirSync(elsewhere)).toEqual(["victim"]);
  });

  it("undoes only what the enable step changed: a running helper is not stopped, an enabled one is not disabled", async () => {
    // running but not enabled, then the probe fails: only `disable` is undone
    const a = fakeOps({ active: true, probeFails: true });
    const ra = await applyRootActions(scratchRequest(path.join(scratch(), "opt"), scratch()), a.ops);
    expect(ra.ok).toBe(false);
    expect(a.calls.filter((c) => /^systemctl (stop|disable)/.test(c))).toEqual([`systemctl disable ${UNIT_NAME}`]);
    expect(a.sys).toEqual({ enabled: false, active: true });
    // enabled but not running: only `stop` is undone
    const b = fakeOps({ enabled: true, probeFails: true });
    await applyRootActions(scratchRequest(path.join(scratch(), "opt"), scratch()), b.ops);
    expect(b.calls.filter((c) => /^systemctl (stop|disable)/.test(c))).toEqual([`systemctl stop ${UNIT_NAME}`]);
    expect(b.sys).toEqual({ enabled: true, active: false });
    // neither: both are undone
    const c = fakeOps({ probeFails: true });
    await applyRootActions(scratchRequest(path.join(scratch(), "opt"), scratch()), c.ops);
    expect(c.sys).toEqual({ enabled: false, active: false });
  });

  it("reloads systemd on a rollback only after the old unit file is back, and never before", async () => {
    const root = path.join(scratch(), "opt");
    const src = scratch();
    const first = scratchRequest(root, src);
    const marked = (req: RootRequest, text: string): RootRequest => ({
      ...req,
      actions: [
        ...req.actions.slice(0, -2).map((a) => (a.op === "install" && a.path.endsWith("/config") ? { ...a, text, sha256: sha(text), length: text.length, reloads: true as const } : a)),
        { op: "daemon-reload" },
        ...req.actions.slice(-2),
      ],
    });
    expect((await applyRootActions(marked(first, "carried text\n"), fakeOps().ops)).ok).toBe(true);
    const f = fakeOps({ probeFails: true });
    const seen: string[] = [];
    const run = f.ops.run;
    f.ops.run = async (file, args) => {
      if (file === "systemctl" && args[0] === "daemon-reload") seen.push(readFileSync(`${root}/config`, "utf8"));
      return run(file, args);
    };
    const r = await applyRootActions(marked(first, "new unit text\n"), f.ops);
    expect(r.ok).toBe(false);
    // once with the new file (forward), once with the old file (rollback), and the step's own undo did not reload
    expect(seen).toEqual(["new unit text\n", "carried text\n"]);
    expect(r.undone.at(-1)).toContain("daemon-reload");
  });

  it("judges every target path and its parents before the first change, and cleans up when a link or rename throws", async () => {
    const parent = scratch();
    const elsewhere = scratch();
    symlinkSync(elsewhere, path.join(parent, "linked"));
    const f = fakeOps();
    const r = await applyRootActions(scratchRequest(path.join(parent, "linked", "deeper", "opt"), scratch()), f.ops);
    expect(r).toMatchObject({ ok: false, done: [], undone: [] });
    expect(f.calls).toEqual([]);
    expect(readdirSync(elsewhere)).toEqual([]);
    // a rename that throws leaves no temp file and no saved old copy
    const root = path.join(scratch(), "opt");
    const req = scratchRequest(root, scratch());
    expect((await applyRootActions(req, fakeOps().ops)).ok).toBe(true);
    const changed = { ...req, actions: req.actions.map((a) => (a.op === "install" && a.path.endsWith("/config") ? { ...a, text: "other\n", sha256: sha("other\n"), length: 6 } : a)) };
    const real = fsCalls.rename;
    fsCalls.rename = () => {
      throw Object.assign(new Error("boom"), { code: "EIO" });
    };
    try {
      expect((await applyRootActions(changed, fakeOps().ops)).ok).toBe(false);
    } finally {
      fsCalls.rename = real;
    }
    expect(readdirSync(root).sort()).toEqual(["bin", "config"]);
    expect(readFileSync(`${root}/config`, "utf8")).toBe("carried text\n");
  });

  it("opens a staged file without blocking: a FIFO swapped in is refused at once, not waited on", async () => {
    const src = scratch();
    const req = scratchRequest(path.join(scratch(), "opt"), src);
    rmSync(path.join(src, "staged"));
    execFileSync("mkfifo", [path.join(src, "staged")]);
    const r = await applyRootActions(req, fakeOps().ops);
    expect(r).toMatchObject({ ok: false, done: [] });
    expect(r.failed).toContain("not a plain file");
  });

  it("refuses staged bytes that do not match their hash, or a staged file the invoking user does not own", async () => {
    const root = path.join(scratch(), "opt");
    const src = scratch();
    const req = scratchRequest(root, src);
    // same length, one byte different, after staging and before the root phase: no step runs at all
    writeFileSync(path.join(src, "staged"), "staged bytez\n");
    const f = fakeOps();
    const tampered = await applyRootActions(req, f.ops);
    expect(tampered).toMatchObject({ ok: false, done: [], undone: [] });
    expect(tampered.failed).toContain("does not match its hash");
    expect(f.calls).toEqual([]);
    expect(existsSync(root)).toBe(false);
    // a second name for the staged file (a hard link the user kept) is refused too
    writeFileSync(path.join(src, "staged"), "staged bytes\n");
    linkSync(path.join(src, "staged"), path.join(src, "keep"));
    expect((await applyRootActions(req, fakeOps().ops)).failed).toContain("one link");
    expect(existsSync(root)).toBe(false);
    // a fresh staging directory, so this is a one-link file and only its owner is wrong
    const other = await applyRootActions({ ...scratchRequest(path.join(scratch(), "opt2"), scratch()), runnerUid: UID + 1 }, fakeOps().ops);
    expect(other.failed).toContain("is not owned by the invoking user");
    expect(other.failed).not.toContain("one link");
  });

  it("probes the helper over a real Unix socket: any protocol reply counts, silence and a missing socket do not", async () => {
    const dir = scratch();
    const sock = path.join(dir, "h.sock");
    const server = createServer((c) => c.on("data", () => c.end('{"ok":false,"protocol":1,"code":"bad_peer"}\n')));
    await new Promise<void>((r) => server.listen(sock, r));
    cleanups.push(() => void server.close());
    expect(await probeHelper(sock, { attempts: 1 })).toBe(true);
    const mute = path.join(dir, "m.sock");
    const quiet = createServer(() => undefined);
    await new Promise<void>((r) => quiet.listen(mute, r));
    cleanups.push(() => void quiet.close());
    expect(await probeHelper(mute, { attempts: 1, timeoutMs: 100 })).toBe(false);
    expect(await probeHelper(path.join(dir, "none.sock"), { attempts: 2, delayMs: 5 })).toBe(false);
  });
});

/** `vm install` itself, with a fake root executor and a fake signed-release client. */
function fakeHost(over: { fetch?: (p: string) => Promise<unknown>; reply?: { code: number | null; stdout: string } } = {}) {
  const stagingRoot = scratch();
  const rootCalls: RootRequest[] = [];
  const asked: string[] = [];
  const files = new Map<string, Buffer>();
  const names = (["vmhelper", "jailer", "firecracker"] as const).map((n) => `${n}-amd64-${sha(n)}`);
  names.forEach((n, i) => files.set(n, Buffer.from(["vmhelper", "jailer", "firecracker"][i]!)));
  for (const k of ["kernel", "rootfs"]) files.set(`vm-fx-agent-0123456789ab/${k}-amd64-${sha(k)}`, Buffer.from(k));
  const fetchOk = async (p: string): Promise<unknown> => {
    const bytes = files.get(p)!;
    const file = path.join(stagingRoot, `dl-${sha(p).slice(0, 8)}`);
    writeFileSync(file, bytes);
    return { ok: true, file, sha256: sha(bytes), length: bytes.length };
  };
  const host: InstallHost = {
    facts: async () => FACTS,
    nodeArch: "x64",
    tuf: { listTargets: async () => ({ ok: true, paths: [...files.keys()] }), fetchTarget: (over.fetch ?? fetchOk) as InstallHost["tuf"]["fetchTarget"] },
    root: { run: async (r) => (rootCalls.push(r), over.reply ?? { code: 0, stdout: `${JSON.stringify({ ok: true, done: ["made it"], unchanged: [], undone: [], undoFailed: [] })}\n` }) },
    confirm: async (q) => (asked.push(q), true),
    hostRefusal: () => undefined,
    tmpRoot: stagingRoot,
  };
  return { host, rootCalls, asked, stagingRoot };
}
const run = async (args: string[], host: InstallHost): Promise<{ code: number; text: string }> => {
  let text = "";
  const code = await installCommand(args, host, (l) => (text += `${l}\n`));
  return { code, text };
};

describe("fx-runner vm install", () => {
  it("--dry-run prints the whole plan and the exact root steps, makes zero root calls, asks nothing and leaves no staging directory", async () => {
    const w = fakeHost();
    const r = await run(["--dry-run"], w.host);
    expect(r.code).toBe(0);
    expect(w.rootCalls).toHaveLength(0);
    expect(w.asked).toEqual([]);
    for (const part of ["group        fx-vmhelper", "Limits: 8 sandboxes, 8 vCPUs, 12288 MB", "Sandbox ids: uid 100000-100007", "[Service]", "Root steps, in order", "install /etc/fx-vmhelper/config.json  root:root 0600", "no root call was made"]) expect(r.text).toContain(part);
    expect(readdirSync(w.stagingRoot).filter((n) => n.startsWith("fx-vm-bundle-"))).toEqual([]);
  });

  it("asks once and makes exactly one root call with the checked request; --yes asks nothing", async () => {
    const a = fakeHost();
    expect((await run([], a.host)).code).toBe(0);
    expect(a.asked).toHaveLength(1);
    expect(a.rootCalls).toHaveLength(1);
    expect(a.rootCalls[0]).toMatchObject({ version: 1, runnerUid: 1000, runnerUser: "alice" });
    expect(checkRequest(a.rootCalls[0], 0).actions.length).toBeGreaterThan(10);
    const b = fakeHost();
    expect((await run(["--yes"], b.host)).code).toBe(0);
    expect(b.asked).toEqual([]);
    expect(b.rootCalls).toHaveLength(1);
    expect(readdirSync(b.stagingRoot).filter((n) => n.startsWith("fx-vm-bundle-"))).toEqual([]);
  });

  it("a declined confirmation makes no root call", async () => {
    const w = fakeHost();
    w.host.confirm = async () => false;
    expect(await run([], w.host)).toMatchObject({ code: 1 });
    expect(w.rootCalls).toHaveLength(0);
  });

  it("a bundle that fails verification means no root phase at all, and no staging directory is left", async () => {
    const w = fakeHost({ fetch: async () => ({ ok: false, state: "refused", message: "x" }) });
    await expect(run(["--yes"], w.host)).rejects.toThrow(/could not be downloaded and verified/);
    expect(w.rootCalls).toHaveLength(0);
    expect(readdirSync(w.stagingRoot).filter((n) => n.startsWith("fx-vm-bundle-"))).toEqual([]);
    // and the real client of a build with no trusted release address says "not configured" the same way, before any root call
    const real = fakeHost();
    real.host.tuf = new TufClient({ stateDir: scratch() });
    await expect(run(["--yes"], real.host)).rejects.toThrow(CliError);
    expect(real.rootCalls).toHaveLength(0);
  });

  it("prints what was done and what was undone when the root side reports a failure, and exits 1", async () => {
    const report = { ok: false, done: ["a", "b"], unchanged: [], undone: ["b", "a"], undoFailed: [], failed: "c: boom" };
    const w = fakeHost({ reply: { code: 1, stdout: `${JSON.stringify(report)}\n` } });
    const r = await run(["--yes"], w.host);
    expect(r.code).toBe(1);
    expect(r.text).toContain("Failed: c: boom");
    expect(r.text).toMatch(/Undone, last first:\n {2}b\n {2}a/);
    expect(r.text).toContain("Everything this run changed has been put back.");
  });

  it("says so when the host was already installed, and refuses unknown options", async () => {
    const same = { ok: true, done: [], unchanged: ["x"], undone: [], undoFailed: [] };
    const w = fakeHost({ reply: { code: 0, stdout: JSON.stringify(same) } });
    expect((await run(["--yes"], w.host)).text).toContain("Already installed: nothing was changed.");
    await expect(run(["--force"], w.host)).rejects.toThrow(INSTALL_USAGE);
  });

  it("refuses a NixOS machine or a link on the way to a target, in one sentence, before anything is staged or asked", async () => {
    const plan = buildInstallPlan({ ...FACTS, smallestTemplateRamMb: 512 });
    const actions = buildRootActions(plan, fixtureBundle(scratch()), FACTS.runner, sha);
    const clean = scratch();
    expect(hostRefusal(actions, clean)).toBeUndefined();
    const nixos = scratch();
    mkdirSync(path.join(nixos, "etc"));
    writeFileSync(path.join(nixos, "etc", "NIXOS"), "");
    expect(hostRefusal(actions, nixos)).toMatch(/NixOS machine.*services\.fx-vmhelper/);
    const linked = scratch();
    mkdirSync(path.join(linked, "etc"));
    symlinkSync(clean, path.join(linked, "etc", "systemd"));
    expect(hostRefusal(actions, linked)).toMatch(/etc\/systemd is a symlink.*services\.fx-vmhelper/);
    const w = fakeHost();
    w.host.hostRefusal = () => "vm install cannot run here (x); use the NixOS module services.fx-vmhelper instead.";
    await expect(run(["--yes"], w.host)).rejects.toThrow(/services\.fx-vmhelper/);
    expect(w.rootCalls).toHaveLength(0);
    expect(w.asked).toEqual([]);
    expect(readdirSync(w.stagingRoot).filter((n) => n.startsWith("fx-vm-bundle-"))).toEqual([]);
  });

  it("allows exactly the install's own paths, root:root, and a plain 0nnn mode (no setuid, setgid or sticky bit)", () => {
    const plan = buildInstallPlan({ ...FACTS, smallestTemplateRamMb: 512 });
    const actions = buildRootActions(plan, fixtureBundle(scratch()), FACTS.runner, sha);
    const req = (a: unknown): RootRequest => ({ version: 1, runnerUid: 1000, runnerUser: "alice", actions: [a as RootAction] });
    const dir = { op: "mkdir", path: LAYOUT.helperDir, owner: "root:root", mode: "0755" };
    expect(() => checkRequest(req(dir), 0)).not.toThrow();
    expect(() => checkRequest({ version: 1, runnerUid: 1000, runnerUser: "alice", actions }, 0)).not.toThrow();
    for (const mode of ["4755", "2755", "1777", "04755", "0755 ", "755", "0888"]) expect(() => checkRequest(req({ ...dir, mode }), 0), mode).toThrow(CliError);
    for (const p of [`${LAYOUT.helperDir}/evil`, `${LAYOUT.helperDir}/bin/x`, `${LAYOUT.templateDir}/Bad`, `${LAYOUT.templateDir}/a/b`, `${LAYOUT.jailRoot}/jails`, `${LAYOUT.configDir}/x`]) expect(() => checkRequest(req({ ...dir, path: p }), 0), p).toThrow(CliError);
    expect(() => checkRequest(req({ ...dir, owner: "alice:alice" }), 0)).toThrow(CliError);
    const file = { op: "install", path: `${LAYOUT.templateDir}/fx-agent/kernel`, owner: "root:root", mode: "0644", sha256: sha("x"), length: 1, text: "x" };
    expect(() => checkRequest(req(file), 0)).not.toThrow();
    expect(() => checkRequest(req({ ...file, path: `${LAYOUT.helperDir}/bin/other` }), 0)).toThrow(CliError);
  });

  it("the root side believes the runner only if SUDO_UID and the account database agree with the request", async () => {
    const plan = buildInstallPlan({ ...FACTS, smallestTemplateRamMb: 512 });
    const actions = buildRootActions(plan, fixtureBundle(scratch()), FACTS.runner, sha);
    const request = JSON.stringify({ version: 1, runnerUid: UID, runnerUser: "alice", actions });
    const go = (sudoUid: string | undefined, ops: Pick<RootOps, "run">): Promise<number> => rootApplyCommand({ euid: 0, sudoUid, readStdin: async () => request, ops }, () => undefined);
    const agrees = fakeOps().ops;
    await expect(go(undefined, agrees)).rejects.toThrow(/not the user who ran sudo/);
    await expect(go(String(UID + 1), agrees)).rejects.toThrow(/not the user who ran sudo/);
    const liar: Pick<RootOps, "run"> = { run: async () => ({ code: 0, output: `alice:x:${UID + 1}:${GID}::/:/bin/sh\n` }) };
    await expect(go(String(UID), liar)).rejects.toThrow(/do not match the account database/);
    const unknown: Pick<RootOps, "run"> = { run: async () => ({ code: 2, output: "" }) };
    await expect(go(String(UID), unknown)).rejects.toThrow(/do not match the account database/);
  });

  it("starts the root side's programs with a fixed PATH and nothing else: no LD_* and no inherited search path", async () => {
    const hosts = createVmInstallHosts({ selfCommand: ["/x"], tuf: {}, confirm: async () => false, buildRootArgv, hostRefusal });
    const saved = { ld: process.env.LD_LIBRARY_PATH, pre: process.env.LD_PRELOAD };
    process.env.LD_LIBRARY_PATH = "/nonexistent-lib";
    process.env.LD_PRELOAD = "/nonexistent.so";
    try {
      const r = await hosts.root.ops.run("/usr/bin/env", []);
      expect(r.output.trim().split("\n")).toEqual([`PATH=${ROOT_PATH}`]);
    } finally {
      if (saved.ld === undefined) delete process.env.LD_LIBRARY_PATH;
      else process.env.LD_LIBRARY_PATH = saved.ld;
      if (saved.pre === undefined) delete process.env.LD_PRELOAD;
      else process.env.LD_PRELOAD = saved.pre;
    }
    expect(ROOT_PATH).toBe("/usr/sbin:/usr/bin:/sbin:/bin");
  });

  it("the root side reads its request from standard input, refuses anything but root, and prints one report line", async () => {
    const req = scratchRequest(path.join(scratch(), "opt"), scratch());
    let out = "";
    const f = fakeOps();
    // outside the install's own places: refused as a whole, before any step
    await expect(rootApplyCommand({ euid: 0, sudoUid: String(UID), readStdin: async () => JSON.stringify(req), ops: f.ops }, (l) => (out += l))).rejects.toThrow(/not one of the install's own places/);
    await expect(rootApplyCommand({ euid: 1000, sudoUid: undefined, readStdin: async () => "{}", ops: f.ops }, () => undefined)).rejects.toThrow(/must run as root/);
    await expect(rootApplyCommand({ euid: 0, sudoUid: String(UID), readStdin: async () => "not json", ops: f.ops }, () => undefined)).rejects.toThrow(/not JSON/);
    expect(out).toBe("");
    expect(f.calls).toEqual([]);
  });
});
