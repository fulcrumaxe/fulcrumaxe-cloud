import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// D#6 R6-5: the checks the release workflows run between their steps, and the script that moves the metadata. The workflow YAML is thin; this is its logic.
const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
let root: string;
let n = 0;
const fresh = (): string => path.join(root, `case-${n++}`);

function check(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, "release-check.mjs"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
}
/** A directory holding the four artifact files, each with the given text. */
function artifacts(dir: string, text: (name: string) => string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ["fx-runner-darwin-arm64", "fx-runner-darwin-x64", "fx-runner-linux-x64", "fx-runner-linux-arm64"]) writeFileSync(path.join(dir, name), text(name));
}
function script(file: string, body: string): string {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "fx-release-check-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("a fresh build directory (the manifest hashes every artifact-named file in its directory)", () => {
  it("accepts a directory that does not exist or is empty, and refuses one with anything in it", () => {
    const missing = fresh();
    expect(check(["fresh-dir", missing]).status).toBe(0);
    mkdirSync(missing);
    expect(check(["fresh-dir", missing]).status).toBe(0);
    writeFileSync(path.join(missing, "fx-runner-linux-x64"), "left over from an earlier build");
    const result = check(["fresh-dir", missing]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("build into a fresh directory");
  });

  it("is what makes a stale file impossible to release: the build script runs the check before it builds", () => {
    const text = readFileSync(path.join(SCRIPTS, "release-build.sh"), "utf8");
    expect(text.indexOf("release-check.mjs\" fresh-dir")).toBeGreaterThan(-1);
    expect(text.indexOf("fresh-dir")).toBeLessThan(text.indexOf("build-sea.mjs"));
  });
});

describe("the reproducibility comparison", () => {
  it("passes identical builds and names the file of a differing one", () => {
    const [a, b] = [fresh(), fresh()];
    artifacts(a, (name) => name);
    artifacts(b, (name) => name);
    expect(check(["compare", a, b]).status).toBe(0);
    writeFileSync(path.join(b, "fx-runner-linux-x64"), "different");
    const result = check(["compare", a, b]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fx-runner-linux-x64 is not reproducible");
  });

  it("refuses builds that made different sets of files", () => {
    const [a, b] = [fresh(), fresh()];
    artifacts(a, (name) => name);
    artifacts(b, (name) => name);
    rmSync(path.join(b, "fx-runner-darwin-x64"));
    expect(check(["compare", a, b]).stderr).toContain("different files");
  });

  it("with --strip-signature compares what is left after the code signature is removed", () => {
    // A stand-in for codesign that deletes a trailing "SIGNATURE:<anything>" line, as removing a signature drops those bytes.
    const stub = script(path.join(fresh() + "-codesign.sh"), `[ "$1" = "--remove-signature" ] || exit 9\nsed -i '/^SIGNATURE:/d' "$2"`);
    const [a, b] = [fresh(), fresh()];
    artifacts(a, (name) => `${name}\nSIGNATURE:one\n`);
    artifacts(b, (name) => `${name}\nSIGNATURE:two\n`);
    expect(check(["compare", a, b]).status).toBe(1);
    expect(check(["compare", a, b, "--strip-signature"], { FX_RELEASE_CODESIGN: stub }).status).toBe(0);
    writeFileSync(path.join(b, "fx-runner-linux-x64"), "linux-x64 but different\nSIGNATURE:two\n");
    expect(check(["compare", a, b, "--strip-signature"], { FX_RELEASE_CODESIGN: stub }).status).toBe(1);
  });
});

describe("the assertion that seaReal.test.ts actually ran", () => {
  const report = (assertionResults: { status: string }[] | undefined, name = "/w/packages/fx-runner/test/release/seaReal.test.ts") => {
    const file = path.join(fresh() + ".json");
    writeFileSync(file, JSON.stringify({ testResults: assertionResults === undefined ? [] : [{ name, assertionResults }] }));
    return file;
  };

  it("passes when every test in the file passed", () => {
    expect(check(["sea-real-ran", report([{ status: "passed" }, { status: "passed" }])]).status).toBe(0);
  });

  it("fails when the suite was skipped, which is what the nodejs.org reachability check or FX_SEA_SKIP_REAL=1 produces", () => {
    const result = check(["sea-real-ran", report([{ status: "skipped" }, { status: "skipped" }])]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("seaReal.test.ts did not run: 0 of 2 passed");
  });

  it("fails on a partly skipped or failed file, an empty file, a missing file entry and an unreadable report", () => {
    expect(check(["sea-real-ran", report([{ status: "passed" }, { status: "skipped" }])]).status).toBe(1);
    expect(check(["sea-real-ran", report([{ status: "passed" }, { status: "failed" }])]).status).toBe(1);
    expect(check(["sea-real-ran", report([])]).status).toBe(1);
    expect(check(["sea-real-ran", report(undefined)]).stderr).toContain("not in the test report");
    expect(check(["sea-real-ran", report([{ status: "passed" }], "/w/test/release/other.test.ts")]).status).toBe(1);
    const garbage = path.join(fresh() + ".json");
    writeFileSync(garbage, "{");
    expect(check(["sea-real-ran", garbage]).stderr).toContain("could not be read");
  });

  it("sees a real vitest run of the real file as skipped when it is told to skip", () => {
    const out = path.join(fresh() + ".json");
    const vitest = spawnSync(process.execPath, [path.join(SCRIPTS, "..", "node_modules", "vitest", "vitest.mjs"), "run", "test/release/seaReal.test.ts", "--reporter=json", `--outputFile=${out}`], {
      cwd: path.join(SCRIPTS, ".."),
      encoding: "utf8",
      env: { ...process.env, FX_SEA_SKIP_REAL: "1" },
    });
    expect(vitest.status).toBe(0);
    const result = check(["sea-real-ran", out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not run");
  }, 120_000);
});

describe("the built-program smoke check", () => {
  it("accepts a program that reports the version and answers the sandbox probe, and refuses one that does not", () => {
    const good = script(fresh() + "-good", `case "$1" in --version) echo "fx-runner 1.2.3 (2026-05-28)";; doctor) echo "PASS Sandbox: ok"; exit 0;; esac`);
    expect(check(["smoke", good, "1.2.3"]).status).toBe(0);
    expect(check(["smoke", good, "1.2.4"]).status).toBe(1);
    const failing = script(fresh() + "-failing", `case "$1" in --version) echo "fx-runner 1.2.3 (x)";; doctor) echo "FAIL Sandbox: bwrap_missing"; exit 1;; esac`);
    expect(check(["smoke", failing, "1.2.3"]).status).toBe(0);
    const broken = script(fresh() + "-broken", `case "$1" in --version) echo "fx-runner 1.2.3 (x)";; doctor) echo "crash"; exit 70;; esac`);
    expect(check(["smoke", broken, "1.2.3"]).status).toBe(1);
  });
});

describe("signing configuration (a missing secret leaves the release a draft)", () => {
  it("passes with the trusted root and every named secret set", () => {
    const rootFile = fresh() + "-root.json";
    writeFileSync(rootFile, "{}");
    expect(check(["signing-configured", rootFile, "TUF_TARGETS_KEY", "TUF_ONLINE_KEY"], { TUF_TARGETS_KEY: "k1", TUF_ONLINE_KEY: "k2" }).status).toBe(0);
  });

  it("fails 'release signing not configured', naming what is missing and never a value", () => {
    const rootFile = fresh() + "-root.json";
    writeFileSync(rootFile, "{}");
    const noSecrets = check(["signing-configured", rootFile, "TUF_TARGETS_KEY", "TUF_ONLINE_KEY"]);
    expect(noSecrets.status).toBe(1);
    expect(noSecrets.stderr).toContain("release signing not configured");
    expect(noSecrets.stderr).toContain("TUF_TARGETS_KEY");
    const empty = check(["signing-configured", rootFile, "TUF_ONLINE_KEY"], { TUF_ONLINE_KEY: "" });
    expect(empty.stderr).toContain("secret TUF_ONLINE_KEY is not set");
    const noRoot = check(["signing-configured", fresh() + "-missing.json", "TUF_ONLINE_KEY"], { TUF_ONLINE_KEY: "SECRET-VALUE" });
    expect(noRoot.status).toBe(1);
    expect(noRoot.stderr).toContain("trusted root file is not in the repository");
    expect(noRoot.stderr).not.toContain("SECRET-VALUE");
  });
});

describe("version and metadata preparation", () => {
  it("accepts only the package's own x.y.z version", () => {
    const own = (JSON.parse(readFileSync(path.join(SCRIPTS, "..", "package.json"), "utf8")) as { version: string }).version;
    expect(check(["version-matches", own]).status).toBe(0);
    expect(check(["version-matches", "9.9.9"]).stderr).toContain("is not the package version");
    expect(check(["version-matches", "v1.0.0"]).stderr).toContain("x.y.z");
  });

  it("puts the trusted root in an empty metadata directory (the first release) and refuses a non-empty one without it", () => {
    const rootFile = fresh() + "-root.json";
    writeFileSync(rootFile, '{"signed":1}');
    const dir = fresh();
    expect(check(["prepare-metadata", dir, rootFile]).status).toBe(0);
    expect(readFileSync(path.join(dir, "1.root.json"), "utf8")).toBe('{"signed":1}');
    const stray = fresh();
    mkdirSync(stray);
    writeFileSync(path.join(stray, "timestamp.json"), "{}");
    expect(check(["prepare-metadata", stray, rootFile]).stderr).toContain("no 1.root.json");
    expect(existsSync(path.join(stray, "1.root.json"))).toBe(false);
  });
});

describe("all four artifacts of the version were checked", () => {
  const output = (text: string): string => {
    const file = path.join(fresh() + ".out");
    writeFileSync(file, text);
    return file;
  };
  it("passes when four files were checked and none of this version is in the not-checked list (older releases may be)", () => {
    expect(check(["all-checked", output("ok\nartifacts checked: 4, not found (not checked): v0.0.9/fx-runner-linux-x64\n"), "0.1.0"]).status).toBe(0);
  });
  it("fails when fewer were checked, when one of this version was not found, or when --artifacts was not given", () => {
    expect(check(["all-checked", output("artifacts checked: 3, not found (not checked): v0.1.0/fx-runner-linux-x64\n"), "0.1.0"]).status).toBe(1);
    expect(check(["all-checked", output("artifacts checked: 4, not found (not checked): v0.1.0/fx-runner-linux-x64\n"), "0.1.0"]).stderr).toContain("not checked: fx-runner-linux-x64");
    expect(check(["all-checked", output("artifacts: not checked (give --artifacts <dir> to check their SHA-256 and length)\n"), "0.1.0"]).stderr).toContain("does not say");
  });
});

describe("release-metadata.sh", () => {
  type Mode = "exists" | "404" | "502" | "401" | "network";
  /** A `gh` that logs its arguments. `api` (the release lookup) answers by mode; `release view` succeeds only when the release exists. */
  function withGh(mode: Mode): { env: Record<string, string>; log: string } {
    const bin = fresh();
    mkdirSync(bin);
    const log = path.join(bin, "calls.log");
    const answers: Record<Mode, string> = {
      exists: "echo '{}'",
      "404": "echo 'gh: Not Found (HTTP 404)' >&2; exit 1",
      "502": "echo 'gh: Bad Gateway (HTTP 502)' >&2; exit 1",
      "401": "echo 'gh: Bad credentials (HTTP 401)' >&2; exit 1",
      network: "echo 'error connecting to api.github.com' >&2; exit 1",
    };
    script(
      path.join(bin, "gh"),
      `echo "$*" >> "${log}"
case "$1 $2" in
  "api repos/owner/repo/releases/tags/tuf-metadata") ${answers[mode]} ;;
  "release view") [ "${mode}" = exists ] && exit 0; exit 1 ;;
  "release download") while [ "$#" -gt 0 ]; do [ "$1" = --dir ] && echo '{}' > "$2/timestamp.json"; shift; done ;;
esac
exit 0`,
    );
    return { env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GITHUB_REPOSITORY: "owner/repo" }, log };
  }
  const run = (args: string[], env: Record<string, string>) => spawnSync("sh", [path.join(SCRIPTS, "release-metadata.sh"), ...args], { encoding: "utf8", env });
  const calls = (log: string): string => (existsSync(log) ? readFileSync(log, "utf8") : "");

  it("uploads timestamp.json last, after every other metadata file", () => {
    const { env, log } = withGh("exists");
    const dir = fresh();
    mkdirSync(dir);
    for (const name of ["timestamp.json", "1.root.json", "2.snapshot.json", "2.targets.json"]) writeFileSync(path.join(dir, name), "{}");
    expect(run(["publish", dir], env).status).toBe(0);
    const uploads = calls(log).split("\n").filter((line) => line.startsWith("release upload"));
    expect(uploads).toHaveLength(4);
    expect(uploads[3]).toContain("timestamp.json");
    expect(uploads.slice(0, 3).join("\n")).not.toContain("timestamp.json");
  });

  it("creates the tuf-metadata release when there is none, and refuses a directory with no timestamp.json", () => {
    const { env, log } = withGh("404");
    const dir = fresh();
    mkdirSync(dir);
    writeFileSync(path.join(dir, "1.root.json"), "{}");
    expect(run(["publish", dir], env).status).toBe(1);
    expect(calls(log)).not.toContain("release upload");
    writeFileSync(path.join(dir, "timestamp.json"), "{}");
    expect(run(["publish", dir], env).status).toBe(0);
    expect(calls(log)).toContain("release create tuf-metadata");
  });

  it("fetch downloads the current metadata when it exists and this is not the first release", () => {
    const { env, log } = withGh("exists");
    const dir = fresh();
    expect(run(["fetch", dir], env).status).toBe(0);
    expect(readdirSync(dir)).toEqual(["timestamp.json"]);
    expect(calls(log)).toContain("release download tuf-metadata");
  });

  it("fetch treats only an HTTP 404 as 'no release yet', and only for an explicitly declared first release", () => {
    const { env, log } = withGh("404");
    const dir = fresh();
    expect(run(["fetch", dir, "true"], env).status).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(calls(log)).not.toContain("release download");
    // without the declaration the same 404 stops the job, so a first-release path is never taken by accident
    const refused = run(["fetch", fresh()], env);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("say so explicitly");
  });

  it.each(["502", "401", "network"] as const)("fetch stops on a %s answer, even for a declared first release, and downloads nothing", (mode) => {
    const { env, log } = withGh(mode);
    for (const args of [["fetch", fresh()], ["fetch", fresh(), "true"]]) {
      const result = run(args, env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("stopping rather than treating it as absent");
    }
    expect(calls(log)).not.toContain("release download");
  });

  it("fetch refuses a declared first release when the metadata release already exists", () => {
    const { env, log } = withGh("exists");
    const result = run(["fetch", fresh(), "true"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(calls(log)).not.toContain("release download");
  });

  it("fetch rejects a third argument that is not true or false", () => {
    expect(run(["fetch", fresh(), "yes"], withGh("exists").env).status).toBe(2);
  });
});

describe("release-verify-draft.sh", () => {
  /** A `gh` that serves draft release 42 holding the given assets; `drafts` is what the release listing answers. */
  function withDraft(assets: Record<string, string>, drafts = "42"): Record<string, string> {
    const bin = fresh();
    mkdirSync(bin);
    const served = path.join(bin, "served");
    mkdirSync(served);
    const names = Object.keys(assets);
    names.forEach((name, i) => writeFileSync(path.join(served, String(100 + i)), assets[name] ?? ""));
    writeFileSync(path.join(bin, "assets.txt"), names.map((name, i) => `${100 + i} ${name}\n`).join(""));
    writeFileSync(path.join(bin, "drafts.txt"), drafts === "" ? "" : `${drafts}\n`);
    script(
      path.join(bin, "gh"),
      `case "$*" in
  *--paginate*) cat "${bin}/drafts.txt" ;;
  *releases/42\\ --jq*) cat "${bin}/assets.txt" ;;
  *releases/assets/*) for last; do :; done; cat "${served}/\${last##*/}" ;;
  *) exit 1 ;;
esac`,
    );
    return { PATH: `${bin}:${process.env.PATH ?? ""}`, GITHUB_REPOSITORY: "owner/repo" };
  }
  const verify = (files: Record<string, string>, env: Record<string, string>) => {
    const dir = fresh();
    mkdirSync(dir);
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    return spawnSync("sh", [path.join(SCRIPTS, "release-verify-draft.sh"), "v1.2.3", dir, fresh()], { encoding: "utf8", env });
  };
  const built = { "install.sh": "echo install", "fx-runner.rb": "class" };

  it("passes when the draft holds exactly the built files with exactly their bytes", () => {
    expect(verify(built, withDraft(built)).status).toBe(0);
  });
  it("refuses a swapped asset, an extra one, a missing one, and anything but exactly one draft", () => {
    expect(verify(built, withDraft({ ...built, "install.sh": "echo evil" })).stderr).toContain("install.sh differs");
    expect(verify(built, withDraft({ ...built, "extra.txt": "x" })).stderr).toContain("extra.txt, which the build did not produce");
    expect(verify(built, withDraft({ "install.sh": "echo install" })).stderr).toContain("missing fx-runner.rb");
    expect(verify(built, withDraft(built, "")).status).toBe(1);
    expect(verify(built, withDraft(built, "42\n43")).status).toBe(1);
  });
});
