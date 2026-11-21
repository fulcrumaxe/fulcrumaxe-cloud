import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D#587 B-5b-3c-i criterion 25: the README says, in plain words, what `--unshare-pid` does and does not cover in the OS sandbox and what the guest changes.
 * A docs test pins the claims, so a rewrite that credits the PID namespace with more than it does (or drops the guest paragraph) fails here.
 */
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readme = readFileSync(path.join(PACKAGE_DIR, "README.md"), "utf8");
const start = readme.indexOf("## The model credential, and what keeps it from the tools the agent runs");
const section = start < 0 ? "" : readme.slice(start, readme.indexOf("\n## ", start + 4));
const flat = section.replace(/\s+/g, " ");

describe("the README's account of the token and the tools the agent runs", () => {
  it("has the section", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(section.length).toBeGreaterThan(500);
  });

  it("names the scrub as what stops inheritance, and the pinned variable", () => {
    expect(flat).toContain("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1");
    expect(flat).toMatch(/The scrub\.\*\* .*This is what stops the token reaching a tool by ordinary inheritance/);
  });

  it("says what `--unshare-pid` covers (the CLI's process and its environ) and what it does not (inheritance, a deliberate copy, a sandbox that cannot start)", () => {
    expect(flat).toContain("`--unshare-pid`");
    expect(flat).toContain("/proc/<pid>/environ");
    expect(flat).toMatch(/does \*\*not\*\* stop inheritance/);
    expect(flat).toMatch(/writes to a file or the network on purpose/);
    expect(flat).toMatch(/if bubblewrap cannot start/);
  });

  it("says what the guest changes: delivery after boot to one program as the ordinary user, a confirmed wipe before any stop or snapshot, and the scrub staying on", () => {
    expect(flat).toContain("In a microVM the guest changes this");
    expect(flat).toMatch(/after the VM is up/);
    expect(flat).toMatch(/exactly one program, the CLI, started as the ordinary user \(never root\)/);
    expect(flat).toMatch(/after a failed job/);
    expect(flat).toMatch(/only after the guest confirms that none is left/);
    expect(flat).toContain("`vm_teardown_incomplete`");
    expect(flat).toMatch(/The scrub stays on in the guest/);
  });

  it("does not credit the PID namespace with hiding the token on its own", () => {
    expect(readme).not.toMatch(/--unshare-pid[^.\n]*(alone|by itself)[^.\n]*(hides|keeps|protects)/i);
  });
});
