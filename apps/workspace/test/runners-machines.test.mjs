// apps/workspace/test/runners-machines.test.mjs
//
// D#845 MC-10a: the Machines tab's logic against a fake call(). The words of every row, nothing null or undefined on screen, the last good list kept when a read
// fails, and the commands the "A computer or server I have" choice shows. The DOM, axe and keys are in e2e/runners.spec.ts.
import { describe, expect, it } from "vitest";
import { KVM_NOTE, VM_INSTALL_COMMAND, addSteps, createMachines, needsVmInstall, readMachine, readMachines, tierText, vmInstallLine } from "../apps/runners/runners-fleet.js";

const R1 = "44444444-4444-4444-8444-444444444441";
const wire = (over = {}) => ({ id: R1, name: "Desktop", tier: "microvm", live: true, claude: true, running: null, ...over });

describe("a machine row", () => {
  it("words the tier, never guesses one a machine has not reported", () => {
    expect(tierText("microvm")).toBe("MicroVM isolation");
    expect(tierText("standard", "absent")).toBe("Standard isolation: one project on this machine (no KVM)");
    expect(tierText("standard", "present")).toBe("Standard isolation: one project on this machine");
    expect(tierText("standard", null)).toBe("Standard isolation: one project on this machine"); // an older runner that never reported: nothing said about KVM
    expect(tierText("standard")).toBe("Standard isolation: one project on this machine");
    expect(tierText("microvm", "absent")).toBe("MicroVM isolation");
    expect(tierText(null, "present")).toBe("Isolation not reported yet");
    expect(tierText(null)).toBe("Isolation not reported yet");
    expect(readMachine(wire({ tier: "bogus" })).tier).toBeNull();
  });

  it("reads the KVM fact as present, absent or null, and never lets another value reach the screen (FU-225)", () => {
    expect(readMachine(wire({ kvm: "present" })).kvm).toBe("present");
    expect(readMachine(wire({ kvm: "absent" })).kvm).toBe("absent");
    for (const bad of [undefined, null, "yes", true, 1, "PRESENT"]) expect(readMachine(wire({ kvm: bad })).kvm, String(bad)).toBeNull();
    expect(readMachine({ id: R1 }).kvm).toBeNull();
  });

  it("shows the vm-install hint only for a standard machine that reported KVM present (the derivation engineTrack.ts uses)", () => {
    expect(needsVmInstall("standard", "present")).toBe(true);
    for (const [tier, kvm] of [["standard", "absent"], ["standard", null], ["microvm", "present"], [null, "present"], ["microvm", null]]) expect(needsVmInstall(tier, kvm), `${tier}/${kvm}`).toBe(false);
    expect(VM_INSTALL_COMMAND).toBe("sudo fx-runner vm install");
    expect(vmInstallLine("Desktop")).toBe("Desktop can run microVMs. Run sudo fx-runner vm install on it.");
  });

  it("reads capacity as Free or Running owner/name, and keeps a nameless machine and a nameless project readable", () => {
    expect(readMachine(wire()).running).toBeNull();
    expect(readMachine(wire({ running: { repo_id: "x", name: "acme/web" } })).running).toBe("acme/web");
    expect(readMachine(wire({ running: { repo_id: "x" } })).running).toBe("a project");
    expect(readMachine(wire({ name: null })).name).toBe("Unnamed machine");
    expect(readMachine(wire({ name: "   " })).name).toBe("Unnamed machine");
    const bare = readMachine({ id: R1 }); // a fact never sent reads as no, never undefined
    expect(bare).toMatchObject({ live: false, claude: false, running: null });
    expect(JSON.stringify(bare)).not.toMatch(/undefined|NaN/);
  });

  it("drops a row with no id and a body that is not a list", () => {
    expect(readMachine({ name: "x" })).toBeNull();
    expect(readMachines({ machines: [wire(), {}, null] })).toHaveLength(1);
    expect(readMachines({})).toBeNull();
    expect(readMachines(null)).toBeNull();
  });
});

describe("the machine list", () => {
  it("loads, then keeps the last good list when a later read fails", async () => {
    let answer = { machines: [wire()] };
    const seen = [];
    const m = createMachines({ call: async () => { if (answer instanceof Error) throw answer; return answer; }, onChange: () => seen.push(m.state.status) });
    expect(m.state.status).toBe("loading");
    await m.load();
    expect(m.state).toMatchObject({ status: "ready" });
    expect(m.state.list).toHaveLength(1);
    answer = new Error("down");
    await m.load();
    expect(m.state.status).toBe("ready");
    expect(m.state.list).toHaveLength(1);
    answer = { nope: true };
    await m.load();
    expect(m.state.status).toBe("ready");
    const first = createMachines({ call: async () => { throw new Error("down"); } });
    await first.load(); // a first read that fails has no list to keep
    expect(first.state).toEqual({ status: "error", list: [] });
  });
});

describe("Add a machine", () => {
  it("shows the install, the link command with the cloud's own origin, and the KVM note", () => {
    const steps = addSteps("https://cloud.example");
    expect(steps.map((s) => s.command)).toEqual([null, "curl -fsSL https://cloud.example/install.sh | sh", "fx-runner setup --cloud-url https://cloud.example"]);
    expect(KVM_NOTE).toContain("sudo fx-runner vm install");
  });
});
