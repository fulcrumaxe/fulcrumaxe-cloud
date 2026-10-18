import { execFileSync } from "node:child_process";
import { constants, openSync } from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_SPILL_CODES, trimmedMarker, type JobSpill } from "@fulcrumaxe/runner-protocol";
import { SpillRefused, prepareSpill, removeSpill, spillRootFor, sweepStaleSpill } from "../../src/job/spillFiles.js";

/**
 * D#600 CX-4b: the daemon's no-follow writer, against the real filesystem and real symlinks. Planted names (a sibling directory and a file the writer must never touch)
 * stand for places outside the spill root.
 */
const RUN = "5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d";
const WHOLE = "the whole finding\nline two with é\n".repeat(20);
let base: string;
let root: string;
let outside: string;
let victim: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "fxr-spill-"));
  root = path.join(base, "cache", "spill");
  outside = path.join(base, "outside");
  mkdirSync(outside);
  victim = path.join(outside, "victim.md");
  writeFileSync(victim, "keep me");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const spill = (...codes: Array<(typeof CONTEXT_SPILL_CODES)[number]>): JobSpill => codes.map((code) => ({ code, text: `${code}: ${WHOLE}` }));
const promptWith = (...codes: Array<(typeof CONTEXT_SPILL_CODES)[number]>): string => `Fix these.\n${codes.map((c) => trimmedMarker(c)).join("\n")}\nDone.\n`;
const refused = (run: () => unknown): boolean => {
  try {
    run();
    return false;
  } catch (error) {
    return error instanceof SpillRefused && error.code === "context_spill_unwritable" && error.message === "context_spill_unwritable";
  }
};
const modeOf = (p: string): number => lstatSync(p).mode & 0o777;

describe("writing the spill", () => {
  it("writes one file per code under <root>/<run id>, full text, files 0444 in a 0700 directory, and the root is made 0700", () => {
    const h = prepareSpill(root, RUN, spill("findings", "note"), promptWith("findings", "note"));
    expect(h.dir).toBe(path.join(root, RUN));
    expect(readdirSync(h.dir).sort()).toEqual(["findings.md", "note.md"]);
    expect(readFileSync(path.join(h.dir, "findings.md"), "utf8")).toBe(`findings: ${WHOLE}`);
    expect(readFileSync(path.join(h.dir, "note.md"), "utf8")).toBe(`note: ${WHOLE}`);
    expect(modeOf(path.join(h.dir, "findings.md"))).toBe(0o444);
    expect(modeOf(h.dir)).toBe(0o700);
    expect(modeOf(root)).toBe(0o700);
  });

  it("points each marker the job holds text for at its file, and leaves the rest of the prompt alone", () => {
    const h = prepareSpill(root, RUN, spill("findings", "note"), promptWith("findings", "note"));
    const out = h.rewrite(promptWith("findings", "note"));
    expect(out).toBe(`Fix these.\n[trimmed: full text at ${path.join(h.dir, "findings.md")}]\n[trimmed: full text at ${path.join(h.dir, "note.md")}]\nDone.\n`);
    expect(out).not.toContain("/fx/context/");
    // The signed text is not touched by the rewrite (a pure function of its input).
    expect(promptWith("findings")).toContain("/fx/context/findings.md");
  });

  it("the path in the marker is the real file: its text is the full text (acceptance 1)", () => {
    const h = prepareSpill(root, RUN, spill("findings"), promptWith("findings"));
    const at = /full text at (.+)\]/.exec(h.rewrite(promptWith("findings")))![1]!;
    expect(readFileSync(at, "utf8")).toBe(`findings: ${WHOLE}`);
  });

  it("git status in the agent's workspace is clean after the spill is written: the root is not inside any workspace (acceptance 5)", () => {
    const workspace = path.join(base, "cache", "workspaces", RUN);
    mkdirSync(workspace, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", workspace]);
    prepareSpill(root, RUN, spill("findings", "note", "map"), promptWith("findings"));
    expect(execFileSync("git", ["-C", workspace, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" })).toBe("");
    expect(path.relative(workspace, root).startsWith("..")).toBe(true);
  });

  it("removes the run's directory and everything in it, and only that (the undo path); a second removal is a no-op", () => {
    const other = prepareSpill(root, "6c1f7d2b-3a5e-4b8f-8d42-9e7a1b2c3d4e", spill("note"), promptWith("note"));
    const h = prepareSpill(root, RUN, spill("findings", "note"), promptWith("findings"));
    removeSpill(h);
    expect(existsSync(h.dir)).toBe(false);
    expect(existsSync(other.dir)).toBe(true);
    expect(existsSync(root)).toBe(true);
    removeSpill(h);
  });

  it("clears the directory an earlier attempt of the same run left, so a retry never sees stale files", () => {
    const first = prepareSpill(root, RUN, spill("findings", "note"), promptWith("findings"));
    const second = prepareSpill(root, RUN, spill("map"), promptWith("map"));
    expect(readdirSync(second.dir)).toEqual(["map.md"]);
    expect(second.dir).toBe(first.dir);
  });

  it("a write that fails removes what it made and refuses with the closed code (no dangling marker)", () => {
    if (process.getuid?.() === 0) return;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o500);
    try {
      expect(refused(() => prepareSpill(root, RUN, spill("findings"), promptWith("findings")))).toBe(true);
    } finally {
      chmodSync(root, 0o700);
    }
    expect(existsSync(path.join(root, RUN))).toBe(false);
  });
});

describe("what is refused before anything is written", () => {
  it("a marker for a code the job holds no text for (it would lead nowhere)", () => {
    expect(refused(() => prepareSpill(root, RUN, spill("findings"), promptWith("findings", "note")))).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it("a code outside the closed list, a '..' code, an absolute code, a repeated code", () => {
    for (const code of ["../victim", "/abs/x", "spec", "findings/../note", "findings.md", ""]) {
      expect(refused(() => prepareSpill(root, RUN, [{ code, text: "t" }] as never, "no marker")), code).toBe(true);
    }
    expect(refused(() => prepareSpill(root, RUN, [{ code: "note", text: "a" }, { code: "note", text: "b" }], "x"))).toBe(true);
    expect(existsSync(path.join(root, RUN))).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("a run id that is not a uuid (a '..' segment, a separator, an absolute path)", () => {
    for (const id of ["..", "../outside", "a/b", "/etc", RUN.toUpperCase(), ""]) expect(refused(() => prepareSpill(root, id, spill("note"), "x")), id).toBe(true);
    expect(readdirSync(outside)).toEqual(["victim.md"]);
  });

  it("a root that is not an absolute normalised path", () => {
    expect(refused(() => prepareSpill("relative/root", RUN, spill("note"), "x"))).toBe(true);
    expect(refused(() => prepareSpill(`${root}/../spill`, RUN, spill("note"), "x"))).toBe(true);
  });
});

describe("no symlink is followed", () => {
  it("a symlinked spill root is refused and nothing is written through it", () => {
    mkdirSync(path.dirname(root), { recursive: true });
    symlinkSync(outside, root);
    expect(refused(() => prepareSpill(root, RUN, spill("findings"), promptWith("findings")))).toBe(true);
    expect(readdirSync(outside)).toEqual(["victim.md"]);
  });

  it("a symlinked run directory is refused, and its target is neither written into nor removed", () => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    symlinkSync(outside, path.join(root, RUN));
    expect(refused(() => prepareSpill(root, RUN, spill("findings"), promptWith("findings")))).toBe(true);
    expect(readdirSync(outside)).toEqual(["victim.md"]);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("a symlink planted where a file goes (in a leftover run directory) is unlinked as a link: its target is not written and not removed", () => {
    mkdirSync(path.join(root, RUN), { recursive: true, mode: 0o700 });
    symlinkSync(victim, path.join(root, RUN, "findings.md"));
    symlinkSync(outside, path.join(root, RUN, "dir"));
    const h = prepareSpill(root, RUN, spill("findings"), promptWith("findings"));
    expect(lstatSync(path.join(h.dir, "findings.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(h.dir, "findings.md"), "utf8")).toBe(`findings: ${WHOLE}`);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(readdirSync(outside)).toEqual(["victim.md"]);
  });

  it("removal of a directory holding a link to the outside unlinks the link and leaves the target", () => {
    const h = prepareSpill(root, RUN, spill("findings"), promptWith("findings"));
    symlinkSync(outside, path.join(h.dir, "escape"));
    symlinkSync(victim, path.join(h.dir, "escape.md"));
    removeSpill(h);
    expect(existsSync(h.dir)).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(readdirSync(outside)).toEqual(["victim.md"]);
  });

  it("a symlinked parent of the root is not followed for the write: the files land only where the root really is", () => {
    const real = path.join(base, "real-cache");
    mkdirSync(real);
    symlinkSync(real, path.join(base, "cache-link"));
    // The daemon's configured root is taken as written; a link INSIDE it is the case that is refused (above). Here the root itself is a plain directory.
    const h = prepareSpill(path.join(base, "cache-link", "spill"), RUN, spill("note"), promptWith("note"));
    expect(readFileSync(path.join(real, "spill", RUN, "note.md"), "utf8")).toBe(`note: ${WHOLE}`);
    removeSpill(h);
  });
});

describe("the write-time guard: a link planted between the directory clear and the open", () => {
  /** An open that plants `plant` at the target first, then runs the real open with the flags it was given (so the flags are what is under test). */
  const planting = (plant: (target: string) => void, flagsSeen: number[] = []): typeof openSync => ((target: string, flags: number, mode?: number) => {
    flagsSeen.push(flags);
    plant(target);
    return openSync(target, flags, mode);
  }) as typeof openSync;

  it("opens every file with O_CREAT, O_EXCL and O_NOFOLLOW (each flag asserted on its own)", () => {
    const flags: number[] = [];
    prepareSpill(root, RUN, spill("findings", "note"), promptWith("findings"), planting(() => undefined, flags));
    expect(flags).toHaveLength(2);
    for (const f of flags) {
      expect(f & constants.O_CREAT).toBe(constants.O_CREAT);
      expect(f & constants.O_EXCL).toBe(constants.O_EXCL);
      expect(f & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(f & constants.O_WRONLY).toBe(constants.O_WRONLY);
    }
  });

  it("a link to a file outside is refused, the target keeps its content, the run directory is removed, and the closed code is the answer", () => {
    expect(refused(() => prepareSpill(root, RUN, spill("findings"), promptWith("findings"), planting((target) => symlinkSync(victim, target))))).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(existsSync(path.join(root, RUN))).toBe(false);
  });

  it("a link to a name that does not exist yet (a dangling link) is refused and nothing is created through it", () => {
    const fresh = path.join(outside, "created-through-link.md");
    expect(refused(() => prepareSpill(root, RUN, spill("note"), promptWith("note"), planting((target) => symlinkSync(fresh, target))))).toBe(true);
    expect(existsSync(fresh)).toBe(false);
    expect(readdirSync(outside)).toEqual(["victim.md"]);
  });

  it("a file planted at the name is refused, not overwritten (O_EXCL)", () => {
    expect(refused(() => prepareSpill(root, RUN, spill("note"), promptWith("note"), planting((target) => writeFileSync(target, "planted"))))).toBe(true);
  });
});

describe("one spill root per state directory under the shared one", () => {
  it("is a direct child of the shared root, stable for a state directory and different for another", () => {
    const a = spillRootFor(root, "/home/jane/.fx-runner");
    const b = spillRootFor(root, "/home/jane/.other");
    expect(path.dirname(a)).toBe(root);
    expect(path.basename(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(spillRootFor(root, "/home/jane/.fx-runner/")).toBe(a);
    expect(b).not.toBe(a);
  });

  it("two daemons sharing one cache neither write, sweep nor remove each other's run directories", () => {
    const mine = spillRootFor(root, path.join(base, "state-a"));
    const theirs = spillRootFor(root, path.join(base, "state-b"));
    const run = prepareSpill(mine, "5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d", spill("note"), promptWith("note"));
    const other = prepareSpill(theirs, "6c1f7d2b-3a5e-4b8f-8d42-9e7a1b2c3d4e", spill("findings"), promptWith("findings"));
    expect(sweepStaleSpill(mine)).toBe(1);
    expect(existsSync(run.dir)).toBe(false);
    expect(readFileSync(path.join(other.dir, "findings.md"), "utf8")).toBe(`findings: ${WHOLE}`);
    // A delete handle of one daemon cannot reach into the other's root.
    expect(refused(() => removeSpill({ root: mine, dir: other.dir, id: other.id }))).toBe(true);
    expect(existsSync(other.dir)).toBe(true);
    removeSpill(other);
  });
});

describe("the start-up sweep of directories a crash left", () => {
  const A = "5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d";
  const B = "6c1f7d2b-3a5e-4b8f-8d42-9e7a1b2c3d4e";

  it("removes every run directory, files and nested directories included, and nothing that is not named like a run", () => {
    prepareSpill(root, A, spill("findings", "note"), promptWith("findings"));
    mkdirSync(path.join(root, B, "nested"), { recursive: true });
    writeFileSync(path.join(root, B, "nested", "x.md"), "x", { mode: 0o444 });
    mkdirSync(path.join(root, "keep-me"));
    writeFileSync(path.join(root, "notes.txt"), "keep");
    expect(sweepStaleSpill(root)).toBe(2);
    expect(readdirSync(root).sort()).toEqual(["keep-me", "notes.txt"]);
  });

  it("unlinks a link named like a run as a link: its target is not entered or removed", () => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    symlinkSync(outside, path.join(root, A));
    symlinkSync(victim, path.join(root, B));
    expect(sweepStaleSpill(root)).toBe(2);
    expect(readdirSync(root)).toEqual([]);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("a spill root that is missing, is a link, or is not an absolute normalised path sweeps nothing and does not throw", () => {
    expect(sweepStaleSpill(root)).toBe(0);
    mkdirSync(path.dirname(root), { recursive: true });
    mkdirSync(path.join(outside, A));
    symlinkSync(outside, root);
    expect(sweepStaleSpill(root)).toBe(0);
    expect(existsSync(path.join(outside, A))).toBe(true);
    expect(sweepStaleSpill("relative/spill")).toBe(0);
    expect(sweepStaleSpill(`${root}/../spill`)).toBe(0);
  });

  it("a second sweep finds nothing", () => {
    prepareSpill(root, A, spill("note"), promptWith("note"));
    expect(sweepStaleSpill(root)).toBe(1);
    expect(sweepStaleSpill(root)).toBe(0);
  });
});

describe("the validated delete root", () => {
  it("a delete outside the root is refused and removes nothing: a directory elsewhere, a path with '..', the root itself", () => {
    const h = prepareSpill(root, RUN, spill("findings"), promptWith("findings"));
    const stat = statSync(outside);
    for (const dir of [outside, path.join(root, "..", "outside"), path.join(root, RUN, ".."), root, path.join(root, RUN, "findings.md")]) {
      expect(refused(() => removeSpill({ root, dir, id: { dev: stat.dev, ino: stat.ino } })), dir).toBe(true);
    }
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(existsSync(path.join(h.dir, "findings.md"))).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  it("a run directory swapped for a link to somewhere else is not entered, and a directory that is not the one made is left alone", () => {
    const h = prepareSpill(root, RUN, spill("findings"), promptWith("findings"));
    // The made directory is moved aside, not deleted, so a directory put in its place cannot reuse its inode.
    renameSync(h.dir, `${h.dir}-aside`);
    symlinkSync(outside, h.dir);
    expect(refused(() => removeSpill(h))).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    rmSync(h.dir);
    mkdirSync(h.dir);
    writeFileSync(path.join(h.dir, "mine.md"), "not the daemon's");
    expect(refused(() => removeSpill(h))).toBe(true);
    expect(readFileSync(path.join(h.dir, "mine.md"), "utf8")).toBe("not the daemon's");
  });

  it("a root that became a link refuses the removal", () => {
    const h = prepareSpill(root, RUN, spill("findings"), promptWith("findings"));
    const moved = `${root}-moved`;
    rmSync(root, { recursive: true });
    mkdirSync(path.join(moved, RUN), { recursive: true });
    writeFileSync(path.join(moved, RUN, "findings.md"), "elsewhere");
    symlinkSync(moved, root);
    expect(refused(() => removeSpill(h))).toBe(true);
    expect(readFileSync(path.join(moved, RUN, "findings.md"), "utf8")).toBe("elsewhere");
  });
});
