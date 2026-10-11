import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/cli.js";
import { CODE_DEPRECATION, CODE_MAX_BYTES } from "../../src/codeSource.js";
import { loadRegistration } from "../../src/config.js";
import { readSecret } from "../../src/secretInput.js";
import { useRig } from "./harness.js";

const rig = useRig();
const uid = process.getuid?.();
const TOKEN = `fxrp_${"Q7w3E9r1".repeat(5)}`;
const CODE_R = `fxrr_${"M4n6B8v2".repeat(5)}`;

type Over = Partial<CliIo> & { fetchFn?: typeof fetch };
async function register(extra: string[], over: Over = {}): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli({
    argv: ["register", ...extra, "--credential-mode", "api_key", "--cloud-url", rig.cloud.origin],
    home: undefined,
    stateDirOverride: rig.dir,
    uid,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    ...over,
  });
  return { code, out, err };
}
const allow = (value: string): void => {
  rig.cloud.validCodes.add(value);
  rig.cloud.codeModes.set(value, "api_key");
};

/** Every process's command line on this machine, from /proc (Linux). */
function processList(): string[] {
  const lines: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      lines.push(readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " "));
    } catch {
      // fx-swallow-ok: a process that ended while the list was read
    }
  }
  return lines;
}

describe.skipIf(!existsSync("/proc/self/cmdline"))("the token on standard input", () => {
  it("registers, and a process-list snapshot taken during the call shows no fxrp_ or fxrr_ text", async () => {
    allow(TOKEN);
    let snapshot: string[] = [];
    const base = globalThis.fetch;
    const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      snapshot = processList();
      return base(input, init);
    }) as typeof fetch;
    const result = await register(["--code-stdin"], { readCode: async () => `${TOKEN}\n`, fetchFn });
    expect(result.code, result.err).toBe(0);
    expect(loadRegistration(rig.dir)?.runner_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(snapshot.length).toBeGreaterThan(5);
    expect(snapshot.filter((line) => /fxr[rp]_/.test(line))).toEqual([]);
    expect(result.out + result.err).not.toContain(TOKEN);
    expect(result.err).not.toContain("deprecat");
  });

  it("the snapshot can see a secret that is on a command line (control for the check above)", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "--", TOKEN], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(processList().some((line) => line.includes(TOKEN))).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("registers with a code (fxrr_) the same way, and refuses an empty input, a wrong shape and a missing reader without printing the value", async () => {
    allow(CODE_R);
    expect((await register(["--code-stdin"], { readCode: async () => `  ${CODE_R}  \r\n` })).code).toBe(0);
    for (const bad of ["", "\n", `fxrx_${"A".repeat(40)}`, "fxrp_short"]) {
      const refused = await register(["--code-stdin"], { readCode: async () => bad });
      expect(refused.code).toBe(2);
      expect(refused.err + refused.out).not.toContain(bad.trim() || "\u0000");
    }
    const noReader = await register(["--code-stdin"]);
    expect(noReader.code).toBe(1);
    expect(noReader.err).toContain("only available from the fx-runner program");
  });

  it("is read through the real stream reader: piped text, a limit, a terminal prompt of its own", async () => {
    const piped = new PassThrough();
    const reading = readSecret(piped, () => undefined, CODE_MAX_BYTES, { prompt: "Registration code or token: ", tooLong: () => new Error("too long") });
    piped.end(`${TOKEN}\n`);
    expect((await reading).trim()).toBe(TOKEN);
    const endless = new PassThrough();
    const refused = readSecret(endless, () => undefined, CODE_MAX_BYTES, { tooLong: () => new Error("too long") });
    endless.write("x".repeat(CODE_MAX_BYTES + 40));
    await expect(refused).rejects.toThrow("too long");
    const spoken: string[] = [];
    const terminal = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const typed = readSecret(terminal, (text) => spoken.push(text), CODE_MAX_BYTES, { prompt: "Registration code or token: " });
    terminal.write(`${TOKEN}\n`);
    expect(await typed).toBe(TOKEN);
    expect(spoken[0]).toBe("Registration code or token: ");
    expect(spoken.join("")).not.toContain(TOKEN);
  });
});

describe("the token in a file", () => {
  const fileIn = (name: string, text: string, mode: number): string => {
    mkdirSync(rig.dir + ".files", { recursive: true });
    const file = path.join(rig.dir + ".files", name);
    writeFileSync(file, text);
    chmodSync(file, mode);
    return file;
  };

  it("a 0600 file owned by the user registers, with or without a trailing newline", async () => {
    allow(TOKEN);
    const result = await register(["--code-file", fileIn("token", `${TOKEN}\n`, 0o600)]);
    expect(result.code, result.err).toBe(0);
    expect(result.err).not.toContain("deprecat");
  });

  it("a 0644 file refuses with exit 2 and names the mode; nothing is read or sent", async () => {
    allow(TOKEN);
    const file = fileIn("loose", `${TOKEN}\n`, 0o644);
    const result = await register(["--code-file", file]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("mode 0644");
    expect(result.err).toContain("0600");
    expect(result.err).not.toContain(TOKEN);
    expect(rig.cloud.seen).toEqual([]);
    for (const mode of [0o660, 0o604, 0o640, 0o602]) expect((await register(["--code-file", fileIn(`m${mode}`, TOKEN, mode)])).code).toBe(2);
  });

  it("refuses a file owned by someone else, when the owner cannot be known, a link, a directory, a missing file and a file too large", async () => {
    allow(TOKEN);
    const good = fileIn("good", TOKEN, 0o600);
    const other = await register(["--code-file", good], { uid: (uid ?? 1000) + 1 });
    expect(other.code).toBe(2);
    expect(other.err).toContain("must be owned by");
    expect((await register(["--code-file", good], { uid: undefined })).code).toBe(2);
    const link = path.join(rig.dir + ".files", "link");
    symlinkSync(good, link);
    const linked = await register(["--code-file", link]);
    expect(linked.code).toBe(2);
    expect(linked.err).toContain("is a link");
    expect((await register(["--code-file", rig.dir + ".files"])).code).toBe(2);
    const missing = await register(["--code-file", path.join(rig.dir, "nope")]);
    expect(missing.code).toBe(2);
    expect((await register(["--code-file", fileIn("big", "A".repeat(600), 0o600)])).code).toBe(2);
    expect((await register(["--code-file", fileIn("empty", "", 0o600)])).code).toBe(2);
    expect(rig.cloud.seen).toEqual([]);
  });
});

describe("--code on the command line", () => {
  it("still works for this release and prints the deprecation line to the error stream", async () => {
    allow(TOKEN);
    const result = await register(["--code", TOKEN]);
    expect(result.code, result.err).toBe(0);
    expect(result.err).toContain(CODE_DEPRECATION);
    expect(result.err).toContain("--code-stdin");
    expect(result.err).not.toContain(TOKEN);
    expect(result.out).not.toContain("deprecat");
  });

  it("is refused together with another source, and when no source is given", async () => {
    allow(TOKEN);
    expect((await register(["--code", TOKEN, "--code-stdin"], { readCode: async () => TOKEN })).code).toBe(2);
    expect((await register(["--code-stdin", "--code-file", "/x"], { readCode: async () => TOKEN })).code).toBe(2);
    expect((await register(["--code", TOKEN, "--code-file", "/x"])).code).toBe(2);
    const none = await register([]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("--code-stdin");
    expect(rig.cloud.seen).toEqual([]);
  });
});

describe("--name", () => {
  it("sends the name with the registration, beside the code and the key", async () => {
    allow(TOKEN);
    const result = await register(["--code-stdin", "--name", "build-server 2"], { readCode: async () => TOKEN });
    expect(result.code, result.err).toBe(0);
    expect(rig.cloud.names).toEqual(["build-server 2"]);
    expect(JSON.parse(rig.cloud.seen[0]!.body)).toMatchObject({ code: TOKEN, name: "build-server 2" });
  });

  it("sends no name key at all when --name is not given", async () => {
    allow(TOKEN);
    await register(["--code-stdin"], { readCode: async () => TOKEN });
    expect(Object.keys(JSON.parse(rig.cloud.seen[0]!.body)).sort()).toEqual(["code", "public_key_jwk"]);
  });

  it("refuses an empty name, a name over 64 characters, a control character and an invisible one before any request", async () => {
    allow(TOKEN);
    for (const bad of ["", "x".repeat(65), "bad\u0007name", "tab\tname", "zero​width", "   "]) {
      const result = await register(["--code-stdin", "--name", bad], { readCode: async () => TOKEN });
      expect(result.code, JSON.stringify(bad)).toBe(2);
    }
    expect(rig.cloud.seen).toEqual([]);
    expect((await register(["--code-stdin", "--name", "é".repeat(64)], { readCode: async () => TOKEN })).code).toBe(0);
  });

  it("tells the person when the cloud predates names, and registers nothing", async () => {
    allow(TOKEN);
    rig.cloud.acceptNames = false;
    const result = await register(["--code-stdin", "--name", "laptop"], { readCode: async () => TOKEN });
    expect(result.code).toBe(1);
    expect(result.err).toContain("does not support --name yet");
    expect(loadRegistration(rig.dir)).toBeUndefined();
    // Without --name the same cloud registers as before.
    expect((await register(["--code-stdin"], { readCode: async () => TOKEN })).code).toBe(0);
  });
});
