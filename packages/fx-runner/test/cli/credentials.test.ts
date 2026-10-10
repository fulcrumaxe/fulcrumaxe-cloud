import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { API_KEY_FILE, CREDENTIALS_DIR } from "../../src/credentials.js";

// Assembled from fragments so no token-shaped literal sits in the source.
const KEY = ["sk-ant-", "api03-", "CLIKEY0123456789abcdefgh"].join("");

let parent: string;
let state: string;
beforeEach(() => {
  parent = mkdtempSync(path.join(tmpdir(), "fxr-credcli-"));
  state = path.join(parent, "state");
});
afterEach(() => rmSync(parent, { recursive: true, force: true }));

async function run(argv: string[], over: { secret?: string | (() => Promise<string>); uid?: number | undefined } = {}): Promise<{ code: number; out: string; err: string; reads: number }> {
  let out = "";
  let err = "";
  let reads = 0;
  const secret = over.secret;
  const readSecret = secret === undefined ? undefined : async () => (reads++, typeof secret === "function" ? secret() : secret);
  const code = await runCli({ argv, home: undefined, stateDirOverride: state, uid: "uid" in over ? over.uid : process.getuid!(), stdout: (t) => (out += t), stderr: (t) => (err += t), ...(readSecret === undefined ? {} : { readSecret }) });
  return { code, out, err, reads };
}

describe("fx-runner credentials", () => {
  it("set-api-key reads the key through readSecret, stores it at 0600 and prints nothing of it", async () => {
    const result = await run(["credentials", "set-api-key"], { secret: `${KEY}\n` });
    expect(result).toMatchObject({ code: 0, out: "API key stored.\n", err: "", reads: 1 });
    expect(readFileSync(path.join(state, CREDENTIALS_DIR, API_KEY_FILE), "utf8")).toBe(KEY);
    expect(statSync(path.join(state, CREDENTIALS_DIR, API_KEY_FILE)).mode & 0o777).toBe(0o600);
  });

  it("refuses a key given as an argument, in any position or spelling, before reading anything, and never echoes it", async () => {
    for (const argv of [["credentials", "set-api-key", KEY], ["credentials", KEY], ["credentials", `--api-key=${KEY}`], ["credentials", "set-api-key", "--key", KEY], ["credentials", `--${KEY}`]]) {
      const result = await run(argv, { secret: KEY });
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.reads).toBe(0);
      expect(result.out + result.err).not.toContain("CLIKEY");
      expect(result.err).toContain("never a key as an argument");
    }
    expect((await run(["credentials"], { secret: KEY })).code).toBe(2);
    expect(() => statSync(state)).toThrow();
  });

  it("refuses an empty, a short-prefixed and an over-long value with api_key_format, writes nothing, and echoes none of it", async () => {
    for (const secret of ["", "\n", "wrong-prefix-0123456789", `sk-ant-${"b".repeat(300)}`]) {
      const result = await run(["credentials", "set-api-key"], { secret });
      expect(result.code).toBe(1);
      expect(result.err).toContain("api_key_format");
      expect(result.out + result.err).not.toContain("wrong-prefix");
      expect(result.out + result.err).not.toContain("bbbbbbbb");
    }
    expect(() => statSync(path.join(state, CREDENTIALS_DIR))).toThrow();
  });

  it("set-api-key without the program's stdin reader is refused, and status says stored or not stored and nothing else", async () => {
    expect((await run(["credentials", "set-api-key"])).code).toBe(1);
    expect(await run(["credentials", "status"])).toMatchObject({ code: 0, out: "not stored\n", err: "" });
    await run(["credentials", "set-api-key"], { secret: KEY });
    expect(await run(["credentials", "status"])).toMatchObject({ code: 0, out: "stored\n", err: "" });
  });

  it("clear-api-key removes the key, once", async () => {
    await run(["credentials", "set-api-key"], { secret: KEY });
    expect(await run(["credentials", "clear-api-key"])).toMatchObject({ code: 0, out: "API key removed.\n" });
    expect(await run(["credentials", "clear-api-key"])).toMatchObject({ code: 0, out: "No API key was stored.\n" });
    expect((await run(["credentials", "status"])).out).toBe("not stored\n");
  });

  it("status on a key file that is not safe is an error with the reason, not 'stored'", async () => {
    await run(["credentials", "set-api-key"], { secret: KEY });
    const result = await run(["credentials", "status"], { uid: process.getuid!() + 1 });
    expect(result.code).toBe(1);
    expect(result.err).toContain("api_key_unsafe");
    expect(result.out + result.err).not.toContain("CLIKEY");
  });

  it("is listed in --help", async () => {
    expect((await run(["--help"])).out).toContain("credentials set-api-key | clear-api-key | status");
  });
});
