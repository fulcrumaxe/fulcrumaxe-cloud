import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allowanceFloorViolation, type AllowanceEntry } from "@fulcrumaxe/runner-protocol";
import { verifyJob } from "../src/daemon/verifyJob.js";
import { allowanceRefusal, checkedAllowances, grantsOf, resolveEntries } from "../src/sandbox/allowances.js";
import { KEYRING, NOW, jobFor, signRaw } from "./helpers/signedJob.js";

const rw = (value: string, access: "read" | "write" = "read"): AllowanceEntry => ({ kind: "path", value, access, reason: "needed by a step" });
const timeout = 600;

describe("R7b: symlinks are resolved before the floor is checked and before binding", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function links(): string {
    const root = mkdtempSync(path.join("/tmp", "r7b-link-"));
    made.push(root);
    mkdirSync(path.join(root, ".ssh"));
    mkdirSync(path.join(root, "fine"));
    symlinkSync("/etc", path.join(root, "to-etc"));
    symlinkSync(path.join(root, ".ssh"), path.join(root, "to-ssh"));
    symlinkSync(path.join(root, "fine"), path.join(root, "to-fine"));
    symlinkSync("/nix/var", path.join(root, "to-nix-var"));
    return root;
  }

  it("refuses an allowed path that is a real symlink into a denied place, for read and for write, and a path under such a link", () => {
    const root = links();
    for (const link of ["to-etc", "to-ssh", "to-nix-var", "to-etc/ssh"]) {
      const target = path.join(root, link);
      // as written the floor passes it: that is the hole this closes
      expect(allowanceFloorViolation(rw(target)), link).toBeNull();
      expect(allowanceRefusal({ entries: [rw(target)], commandTimeoutS: timeout }), link).not.toBeNull();
      expect(allowanceRefusal({ entries: [rw(target, "write")], commandTimeoutS: timeout }), link).not.toBeNull();
    }
  });

  it("control: a link to a harmless place passes, and is bound where it really lands", () => {
    const root = links();
    const link = path.join(root, "to-fine");
    expect(allowanceRefusal({ entries: [rw(link, "write")], commandTimeoutS: timeout })).toBeNull();
    expect(resolveEntries([rw(link, "write")])[0]!.value).toBe(path.join(root, "fine"));
    expect(grantsOf(resolveEntries([rw(link, "write")])).writePaths).toEqual([path.join(root, "fine")]);
  });

  it("verifyJob refuses a signed job with such a link", () => {
    const root = links();
    const signed = signRaw(jobFor({ sandbox_allowances: { entries: [rw(path.join(root, "to-ssh"))], command_timeout_s: timeout } }));
    expect(verifyJob(signed, KEYRING, NOW)).toEqual({ ok: false, reason: "sandbox_allowance_forbidden" });
  });
  describe("a dangling symlink is followed to the place it names (CWE-367 / CWE-59)", () => {
    function dangling(): string {
      const root = mkdtempSync(path.join("/tmp", "r7b-dangle-"));
      made.push(root);
      mkdirSync(path.join(root, ".ssh"));
      mkdirSync(path.join(root, "fine"));
      symlinkSync("/etc/fx-not-there-yet", path.join(root, "to-etc"));
      symlinkSync(path.join(root, ".ssh", "not-there-yet"), path.join(root, "to-ssh"));
      symlinkSync("to-etc", path.join(root, "chain"));
      symlinkSync("../.ssh/newkey", path.join(root, "fine", "relative"));
      symlinkSync(path.join(root, "fine", "future"), path.join(root, "to-fine"));
      symlinkSync("loop-b", path.join(root, "loop-a"));
      symlinkSync("loop-a", path.join(root, "loop-b"));
      return root;
    }

    it("refuses a dangling link whose target is in a denied place: absolute, relative, in a chain, for read and write", () => {
      const root = dangling();
      for (const link of ["to-etc", "to-ssh", "chain", "fine/relative"]) {
        const target = path.join(root, link);
        // as written the floor passes it, and a name that does not exist cannot be realpath'd: both are the hole this closes
        expect(allowanceFloorViolation(rw(target)), link).toBeNull();
        expect(allowanceRefusal({ entries: [rw(target)], commandTimeoutS: timeout }), link).not.toBeNull();
        expect(allowanceRefusal({ entries: [rw(target, "write")], commandTimeoutS: timeout }), link).not.toBeNull();
      }
    });

    it("resolves the name under a dangling link too, and fails closed on a loop", () => {
      const root = dangling();
      expect(allowanceRefusal({ entries: [rw(path.join(root, "to-etc", "sub"), "write")], commandTimeoutS: timeout })).not.toBeNull();
      expect(allowanceRefusal({ entries: [rw(path.join(root, "loop-a"))], commandTimeoutS: timeout })).toBe("path_malformed");
      expect(allowanceRefusal({ entries: [rw(path.join(root, "loop-a", "x"))], commandTimeoutS: timeout })).toBe("path_malformed");
    });

    it("control: a dangling link to a harmless place passes and is bound where it would land", () => {
      const root = dangling();
      const link = path.join(root, "to-fine");
      expect(allowanceRefusal({ entries: [rw(link, "write")], commandTimeoutS: timeout })).toBeNull();
      expect(resolveEntries([rw(link, "write")])[0]!.value).toBe(path.join(root, "fine", "future"));
    });

    it("verifyJob refuses a signed job with a dangling link into a credential directory", () => {
      const root = dangling();
      const signed = signRaw(jobFor({ sandbox_allowances: { entries: [rw(path.join(root, "to-ssh"))], command_timeout_s: timeout } }));
      expect(verifyJob(signed, KEYRING, NOW)).toEqual({ ok: false, reason: "sandbox_allowance_forbidden" });
    });
  });

  it("resolves once: the checked list is the resolved list, and that is what is bound", () => {
    const root = links();
    const checked = checkedAllowances({ entries: [rw(path.join(root, "to-fine"), "write")], commandTimeoutS: timeout });
    expect(checked).toEqual({ ok: true, entries: [rw(path.join(root, "fine"), "write")] });
    // swapping the link afterwards changes nothing about what the checked list holds
    rmSync(path.join(root, "to-fine"));
    symlinkSync("/etc", path.join(root, "to-fine"));
    expect(checked.ok && grantsOf(checked.entries).writePaths).toEqual([path.join(root, "fine")]);
  });
});
