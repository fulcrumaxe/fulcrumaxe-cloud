// apps/workspace/test/vm-install-copy.test.mjs
//
// D#845 FU-225: a standard machine that reported KVM present is told to run the vm install. The words live in onboarding-engine.js (the machine step) and runners-fleet.js (a Machines
// row); this pins that the two apps say exactly the same thing. The drawn screens are in e2e/onboarding.spec.ts and e2e/runners.spec.ts.

import { describe, expect, it } from "vitest";
import { describeStep, fixFor } from "../apps/onboarding/onboarding-engine.js";
import { VM_INSTALL_COMMAND, needsVmInstall, vmInstallLine } from "../apps/runners/runners-fleet.js";

const IDS = ["machine", "claude", "github_app", "project", "plan", "install", "live"];
const steps = IDS.map((id) => ({ step: id, state: id === "machine" ? "done" : "pending", completed_at: id === "machine" ? "2026-11-20T10:00:00.000Z" : null, tier: id === "machine" ? "standard" : null, failure: null }));

describe("the vm-install hint", () => {
  it("Onboarding and Machines say the same sentence and offer the same command, for any machine name", () => {
    for (const name of ["box-1", "Desktop", "Unnamed machine"]) {
      const fix = fixFor("microvm_helper_missing", name);
      expect(vmInstallLine(name)).toBe(fix.text);
      expect(VM_INSTALL_COMMAND).toBe(fix.cmd);
    }
  });
  it("what the Onboarding machine step really shows for a standard machine with KVM present is that sentence and command", () => {
    const v = describeStep(steps, 0, { name: "box-1", origin: "https://cloud.example.test", machine: { kvm: "present", helper_missing: true } });
    expect(v.lines).toContain(vmInstallLine("box-1"));
    expect(v.commands.map((c) => c.text)).toEqual([VM_INSTALL_COMMAND]);
  });
  it("both apps derive the hint from the same two facts: standard tier and KVM present", () => {
    expect(needsVmInstall("standard", "present")).toBe(true);
    expect(needsVmInstall("standard", "absent")).toBe(false);
    const absent = describeStep(steps, 0, { name: "box-1", origin: "https://cloud.example.test", machine: { kvm: "absent" } });
    expect(absent.commands.map((c) => c.text)).not.toContain(VM_INSTALL_COMMAND);
  });
});
