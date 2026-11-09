import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SETTINGS_FILE, SETTING_KEYS, loadSettings, parseDeployArgv, setSetting, unsetSetting } from "../src/runnerSettings.js";
import { tmpRoot } from "./helpers/tmpRoot.js";

/** D#749 V2b: the owner's local values for the post-merge verify stage. They live in the runner's own settings file, are set by the owner at a terminal, and are in no cloud message. */
const root = mkdtempSync(path.join(tmpRoot(), "verify-settings-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(root, "s-"));
});

const saved = (): string => readFileSync(path.join(dir, SETTINGS_FILE), "utf8");

describe("verify settings", () => {
  it("are three keys of `config set`, and absent until set", () => {
    expect(SETTING_KEYS).toEqual(expect.arrayContaining(["verify.deploy_argv", "verify.deploy_dir", "verify.test_account"]));
    expect(loadSettings(dir).verify).toBeUndefined();
  });

  it("the deploy command is a JSON array of words; it round-trips and nothing else is stored", () => {
    expect(setSetting(dir, "verify.deploy_argv", '["bash", ".autonomous-team/deploy-staging.sh"]')).toContain("set");
    expect(loadSettings(dir).verify).toEqual({ deployArgv: ["bash", ".autonomous-team/deploy-staging.sh"] });
    expect(JSON.parse(saved()).verify).toEqual({ deployArgv: ["bash", ".autonomous-team/deploy-staging.sh"] });
  });

  it("refuses a command that is not an array of plain words, and writes nothing", () => {
    for (const text of ["bash deploy.sh", "not json", "[]", '"bash"', "[1]", '["bash", ""]', '["bash", "  "]', '["a\\nb"]', '["a\\u0000b"]', '["bash", "x\\u202ey"]', JSON.stringify(Array.from({ length: 33 }, () => "x")), JSON.stringify(["x".repeat(501)]), '{"0":"bash"}', "null"]) {
      expect(() => setSetting(dir, "verify.deploy_argv", text), text).toThrow(/JSON array/);
    }
    expect(loadSettings(dir).verify).toBeUndefined();
    expect(parseDeployArgv(["a", "b"])).toEqual(["a", "b"]);
    expect(parseDeployArgv("a")).toBeUndefined();
  });

  it("the checkout is an absolute, plainly written path", () => {
    setSetting(dir, "verify.deploy_dir", "/home/owner/repos/widgets");
    expect(loadSettings(dir).verify).toEqual({ deployDir: "/home/owner/repos/widgets" });
    for (const text of ["relative/path", "/a/../b", "/a/./b", "/a//b", "/a/b/", "", "/a\nb", `/${"x".repeat(1100)}`]) {
      expect(() => setSetting(dir, "verify.deploy_dir", text), text).toThrow(/absolute path/);
    }
    expect(loadSettings(dir).verify).toEqual({ deployDir: "/home/owner/repos/widgets" });
  });

  it("the test account is a plain label", () => {
    setSetting(dir, "verify.test_account", "fx-test-user");
    expect(loadSettings(dir).verify).toEqual({ testAccount: "fx-test-user" });
    for (const text of ["", " lead", "-lead", "a b", "a/b", "x".repeat(101), "a;b"]) expect(() => setSetting(dir, "verify.test_account", text), text).toThrow(/account label/);
  });

  it("setting one value keeps the others, and the concurrency settings are untouched", () => {
    setSetting(dir, "concurrency.total", "3");
    setSetting(dir, "verify.test_account", "fx-test-user");
    setSetting(dir, "verify.deploy_dir", "/srv/repo");
    setSetting(dir, "verify.deploy_argv", '["sh","d.sh"]');
    expect(loadSettings(dir)).toMatchObject({ ceilingTotal: 3, verify: { deployArgv: ["sh", "d.sh"], deployDir: "/srv/repo", testAccount: "fx-test-user" } });
  });

  it("unset removes one value (the undo), and the whole block when the last one goes; other settings stay", () => {
    setSetting(dir, "concurrency.heavy", "2");
    setSetting(dir, "verify.test_account", "fx-test-user");
    setSetting(dir, "verify.deploy_dir", "/srv/repo");
    expect(unsetSetting(dir, "verify.test_account")).toContain("cleared");
    expect(loadSettings(dir).verify).toEqual({ deployDir: "/srv/repo" });
    unsetSetting(dir, "verify.deploy_dir");
    expect(loadSettings(dir).verify).toBeUndefined();
    expect(JSON.parse(saved())).not.toHaveProperty("verify");
    expect(loadSettings(dir).ceilingHeavy).toBe(2);
    expect(() => unsetSetting(dir, "verify.nope")).toThrow(/unknown setting/);
  });

  it("a damaged value in the file is absent, never guessed: the other values still load", () => {
    setSetting(dir, "concurrency.total", "2");
    const file = JSON.parse(saved());
    file.verify = { deployArgv: ["sh", 5], deployDir: "relative", testAccount: "ok-user" };
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(file));
    expect(loadSettings(dir).verify).toEqual({ testAccount: "ok-user" });
    file.verify = "text";
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(file));
    expect(loadSettings(dir).verify).toBeUndefined();
  });
});
