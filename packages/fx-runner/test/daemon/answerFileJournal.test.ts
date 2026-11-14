import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readVerifyAnswer } from "../../src/daemon/answerFile.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

describe("a finished verify run leaves one journal line per journey", () => {
  const root = mkdtempSync(path.join(tmpRoot(), "answer-journal-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => vi.restoreAllMocks());
  const UID = process.getuid?.() ?? 0;

  it("names the run, the journey, its result, the step count, and the last step's words and page fact", () => {
    const answer = {
      journeys: [
        { id: "c1", result: "pass", steps: [{ did: "opened", dom_fact: "Count: 3" }, { did: "read the mode", dom_fact: "Runs in Local-only" }], console_errors: 0, undo_checked: true, reloaded: true },
        { id: "c2", result: "blocked", steps: [], console_errors: 0, undo_checked: false, reloaded: false },
      ],
    };
    mkdirSync(path.join(root, "abcdef12-run"), { recursive: true });
    const file = path.join(root, "abcdef12-run", "answer.json");
    writeFileSync(file, JSON.stringify(answer), { mode: 0o600 });
    chmodSync(file, 0o600);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(readVerifyAnswer(root, "abcdef12-run", UID)).toEqual(answer);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      "fx-runner: verify journey abcdef12 c1 pass steps=2 last=read the mode | Runs in Local-only",
      "fx-runner: verify journey abcdef12 c2 blocked steps=0 last= | ",
    ]);
  });

  it("writes nothing for an answer that is not accepted", () => {
    mkdirSync(path.join(root, "bad-run"), { recursive: true });
    const file = path.join(root, "bad-run", "answer.json");
    writeFileSync(file, "not json", { mode: 0o600 });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(readVerifyAnswer(root, "bad-run", UID)).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
});
