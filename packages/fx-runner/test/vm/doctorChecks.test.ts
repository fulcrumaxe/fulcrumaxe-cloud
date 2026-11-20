import { describe, expect, it } from "vitest";
import { vmInstallChecks, type PathMeta, type VmInstallFacts } from "../../src/vm/doctorChecks.js";

/** D#587 B-2a-2 PR-4: the doctor checks for an installed helper, driven by injected facts. Nothing here reads the machine or calls root. */
const SHA = "a".repeat(64);
const meta = (over: Partial<PathMeta> = {}): PathMeta => ({ kind: "file", uid: 0, gid: 0, mode: 0o600, ...over });
const GOOD: VmInstallFacts = {
  unit: "active",
  socket: "answers",
  binary: { state: "ok", value: SHA },
  signed: { state: "ok", value: SHA },
  config: { state: "ok", value: meta() },
  jailRoot: { state: "ok", value: meta({ kind: "dir", mode: 0o711 }) },
  group: { user: "alice", exists: true, member: true, active: true },
  kvm: "present",
};
const LABELS = ["VM unit", "VM helper", "VM binary", "VM config", "VM jail root", "VM group", "VM KVM"];
const check = (facts: VmInstallFacts, label: string) => vmInstallChecks(facts).find((c) => c.label === label)!;
const unreadable = { state: "unreadable", why: "EACCES" } as const;

describe("vm install checks", () => {
  it("a good host passes all seven checks, each its own line", () => {
    const all = vmInstallChecks(GOOD);
    expect(all.map((c) => c.label)).toEqual(LABELS);
    expect(all.map((c) => c.level)).toEqual(Array(7).fill("PASS"));
  });

  it("a host with no trace of the install gets one INFO line and no failure", () => {
    const none = vmInstallChecks({ ...GOOD, unit: "absent", binary: { state: "absent" }, config: { state: "absent" }, jailRoot: { state: "absent" }, group: { user: "alice", exists: false, member: false, active: false } });
    expect(none).toEqual([{ level: "INFO", label: "VM helper", detail: "not installed. VM mode is optional; to use it, run: fx-runner vm install" }]);
  });

  // [label, facts that break it, level, text the person must be able to act on]
  const CASES: Array<[string, Partial<VmInstallFacts>, "WARN" | "FAIL", RegExp]> = [
    ["VM unit", { unit: "inactive" }, "FAIL", /is inactive\. Start it with: sudo systemctl restart fx-vmhelper\.service/],
    ["VM unit", { unit: "failed" }, "FAIL", /journalctl -u fx-vmhelper\.service/],
    ["VM unit", { unit: "absent" }, "FAIL", /not installed; run: fx-runner vm install/],
    ["VM unit", { unit: "unknown" }, "WARN", /could not be asked/],
    ["VM helper", { socket: "silent" }, "FAIL", /does not answer\. Restart it with: sudo systemctl restart/],
    ["VM helper", { socket: "absent" }, "FAIL", /no socket: the helper is not running/],
    ["VM helper", { socket: "unreadable" }, "WARN", /could not be reached by this user.*log(ged)? in again/],
    ["VM binary", { binary: { state: "ok", value: "b".repeat(64) } }, "FAIL", /does not match the signed record \(installed bbbbbbbbbbbb, signed aaaaaaaaaaaa\).*fx-runner vm install/],
    ["VM binary", { binary: { state: "absent" } }, "FAIL", /is missing; run: fx-runner vm install/],
    ["VM binary", { binary: unreadable }, "WARN", /could not be read by this user \(EACCES\)/],
    ["VM binary", { signed: unreadable }, "WARN", /signed release record could not be read \(EACCES\).*not compared/],
    ["VM binary", { signed: { state: "absent" } }, "WARN", /signed release record could not be read, so/],
    ["VM config", { config: { state: "ok", value: meta({ uid: 1000 }) } }, "FAIL", /owned by uid 1000 gid 0, mode 0600.*sudo chown root:root \/etc\/fx-vmhelper\/config\.json && sudo chmod 600/],
    ["VM config", { config: { state: "ok", value: meta({ mode: 0o644 }) } }, "FAIL", /mode 0644/],
    ["VM config", { config: { state: "ok", value: meta({ gid: 100 }) } }, "FAIL", /gid 100/],
    ["VM config", { config: { state: "ok", value: meta({ kind: "dir" }) } }, "FAIL", /not a plain file/],
    ["VM config", { config: { state: "absent" } }, "FAIL", /is missing/],
    ["VM config", { config: unreadable }, "WARN", /could not be examined by this user \(EACCES\)/],
    ["VM jail root", { jailRoot: { state: "ok", value: meta({ kind: "dir", mode: 0o755 }) } }, "FAIL", /mode 0755.*0711.*sudo chmod 711 \/var\/lib\/fx-vm/],
    ["VM jail root", { jailRoot: { state: "ok", value: meta({ kind: "dir", mode: 0o711, uid: 1000 }) } }, "FAIL", /uid 1000/],
    ["VM jail root", { jailRoot: { state: "absent" } }, "FAIL", /is missing/],
    ["VM jail root", { jailRoot: unreadable }, "WARN", /could not be examined/],
    ["VM group", { group: { user: "alice", exists: true, member: false, active: false } }, "FAIL", /sudo usermod -aG fx-vmhelper alice, then log out and in again/],
    ["VM group", { group: { user: "alice", exists: false, member: false, active: false } }, "FAIL", /does not exist; run: fx-runner vm install/],
    ["VM group", { group: { user: "alice", exists: true, member: true, active: false } }, "WARN", /vm helper installed, re-login needed/],
    ["VM group", { group: { user: "alice", exists: undefined, member: undefined, active: undefined } }, "WARN", /could not be read/],
    ["VM KVM", { kvm: "absent" }, "FAIL", /\/dev\/kvm does not exist/],
    ["VM KVM", { kvm: "unreadable" }, "WARN", /cannot read and write it, or it could not be examined.*kvm group/],
  ];
  it.each(CASES)("%s: %j is %s", (label, broken, level, text) => {
    const c = check({ ...GOOD, ...broken }, label);
    expect(c.level).toBe(level);
    expect(c.detail).toMatch(text);
    // every other check is unaffected: one fault, one line
    expect(vmInstallChecks({ ...GOOD, ...broken }).filter((x) => x.level !== "PASS" && x.label !== label)).toEqual([]);
  });

  it("every check has a PASS, a WARN and a FAIL case, and no line prints null or undefined", () => {
    for (const label of LABELS) expect([...new Set(CASES.filter((c) => c[0] === label).map((c) => c[2]))].sort(), label).toEqual(["FAIL", "WARN"]);
    for (const [, broken] of CASES) expect(JSON.stringify(vmInstallChecks({ ...GOOD, ...broken }).map((c) => c.detail))).not.toMatch(/null|undefined/);
  });
});

describe("the VM image line (B-5a-BF criterion 11)", () => {
  const image = { ok: true, release: "vm-fx-agent-0123456789ab", arch: "amd64", digests: { kernel: "1".repeat(64), rootfs: "2".repeat(64), agent: "3".repeat(64) } } as const;
  const gone = { ...GOOD, unit: "absent", binary: { state: "absent" }, config: { state: "absent" }, jailRoot: { state: "absent" }, group: { user: "alice", exists: false, member: false, active: false } } as const;

  it("an installed host gets one more line, PASS with the release and short digests", () => {
    const all = vmInstallChecks({ ...GOOD, image });
    expect(all.map((c) => c.label)).toEqual([...LABELS, "VM image"]);
    expect(all.at(-1)).toEqual({ level: "PASS", label: "VM image", detail: `release vm-fx-agent-0123456789ab for amd64: kernel ${"1".repeat(12)}, root disk ${"2".repeat(12)} and agent ${"3".repeat(12)} are listed in the signed metadata (checked just now)` });
  });

  it("a refusal is a FAIL in microvm mode and a WARN otherwise, with the fix in the sentence", () => {
    const refused = { ...GOOD, image: { ok: false, code: "image_not_installed" } } as const;
    expect(vmInstallChecks(refused, { microvm: true }).at(-1)).toMatchObject({ level: "FAIL", label: "VM image", detail: expect.stringContaining("run: fx-runner vm install") });
    expect(vmInstallChecks(refused).at(-1)).toMatchObject({ level: "WARN", label: "VM image" });
    expect(vmInstallChecks({ ...GOOD, image: { ok: false, code: "image_not_listed" } }, { microvm: true }).at(-1)?.detail).toBe("the installed image is not the current signed release: run fx-runner vm install");
  });

  it("nothing installed: the one INFO line stands without the image line, unless microvm was asked for, which fails", () => {
    const info = { level: "INFO", label: "VM helper", detail: "not installed. VM mode is optional; to use it, run: fx-runner vm install" };
    const none = { ...gone, image: { ok: false, code: "image_not_configured" } } as const;
    expect(vmInstallChecks(none)).toEqual([info]);
    expect(vmInstallChecks(none, { microvm: true })).toEqual([info, { level: "FAIL", label: "VM image", detail: expect.stringContaining("nothing falls back to the OS sandbox") }]);
  });

  it("no image fact, no line", () => {
    expect(vmInstallChecks(GOOD, { microvm: true }).map((c) => c.label)).toEqual(LABELS);
  });
});
