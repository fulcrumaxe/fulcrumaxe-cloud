import { execFileSync } from "node:child_process";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../src/cliError.js";
import { credentialsCommand } from "../src/commands/credentials.js";
import type { CommandContext } from "../src/context.js";
import { readSecretFile, type SecretFileSpec } from "../src/credentials/secretFile.js";
import { VM_TOKEN_SPEC, VM_TOKEN_USAGE, VM_TOKEN_DIR, VM_TOKEN_FILE, VM_TOKEN_MAX, VM_TOKEN_PROMPT, VmTokenError, clearVmToken, parseVmToken, readVmToken, vmTokenStatus, writeVmToken } from "../src/credentials/vmToken.js";
import { readSecret, type SecretStream } from "../src/secretInput.js";

// Fake tokens, assembled from fragments so no token-shaped literal sits in the source. The shape is the Spec's assumption, not a real token's.
const TOKEN = ["sk-ant-", "oat01-", "FAKETOKEN0123456789abcdef"].join("");
const OTHER = ["sk-ant-", "oat01-", "SECONDTOKEN9876543210zyxwv"].join(""); // gitleaks:allow
const ENV_TOKEN = ["sk-ant-", "oat01-", "FROMTHEENVIRONMENT000000"].join("");
const UID = process.getuid!();

let state: string;
beforeEach(() => {
  state = path.join(mkdtempSync(path.join(tmpdir(), "fxr-vmtok-")), "state");
});
afterEach(() => rmSync(path.dirname(state), { recursive: true, force: true }));

const dir = (): string => path.join(state, VM_TOKEN_DIR);
const file = (): string => path.join(dir(), VM_TOKEN_FILE);
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof VmTokenError ? error.code : `not a VmTokenError: ${String(error)}`;
  }
  return undefined;
};
const status = (): string => vmTokenStatus(state, UID).state;

describe("what a token may look like (vm_token_format)", () => {
  it("takes a token with one trailing newline", () => {
    expect(parseVmToken(`${TOKEN}\n`)).toBe(TOKEN);
    expect(parseVmToken(`${TOKEN}\r\n`)).toBe(TOKEN);
  });
  it.each([
    ["empty", ""],
    ["only a newline", "\n"],
    ["only the prefix", "sk-ant-oat"],
    ["too short", "sk-ant-oat01-abc"],
    ["an API key prefix", `sk-ant-api03-${"a".repeat(30)}`],
    ["over 512 characters", `sk-ant-oat${"a".repeat(VM_TOKEN_MAX)}`],
    ["a space", `${TOKEN} x`],
    ["a second line", `${TOKEN}\nmore`],
    ["a control byte", `${TOKEN}\u0001`],
    ["a byte over 126", `${TOKEN}é`],
  ])("refuses %s, and the message holds no part of the value", (_name, value) => {
    let message = "";
    try {
      parseVmToken(value);
    } catch (error) {
      expect((error as VmTokenError).code).toBe("vm_token_format");
      message = (error as Error).message;
    }
    expect(message).toMatch(/^vm_token_format: /);
    expect(message).not.toContain("a".repeat(20));
  });
  it("accepts exactly 20 and exactly 512 characters", () => {
    expect(parseVmToken(`sk-ant-oat${"a".repeat(10)}`)).toHaveLength(20);
    expect(parseVmToken(`sk-ant-oat${"a".repeat(VM_TOKEN_MAX - 10)}`)).toHaveLength(VM_TOKEN_MAX);
  });
});

describe("the file, in every state", () => {
  it("missing, at every level", () => {
    expect(status()).toBe("missing");
    mkdirSync(state, { mode: 0o700 });
    expect(status()).toBe("missing");
    mkdirSync(dir(), { mode: 0o700 });
    expect(status()).toBe("missing");
    expect(codeOf(() => readVmToken(state, UID, () => undefined))).toBeUndefined();
  });
  it("safe: written at 0600 in a 0700 directory, holding the token and nothing else, no temporary file left", () => {
    writeVmToken(state, UID, `${TOKEN}\n`);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(statSync(dir()).mode & 0o777).toBe(0o700);
    expect(readFileSync(file(), "utf8")).toBe(TOKEN);
    expect(readdirSync(dir())).toEqual([VM_TOKEN_FILE]);
    expect(status()).toBe("present");
    expect(readVmToken(state, UID, () => undefined).toString("utf8")).toBe(TOKEN);
  });
  it("a bad token writes nothing", () => {
    expect(codeOf(() => writeVmToken(state, UID, "nope"))).toBe("vm_token_format");
    expect(() => lstatSync(dir())).toThrow();
  });
  it("rotate: writing again replaces the token in one rename", () => {
    writeVmToken(state, UID, TOKEN);
    writeVmToken(state, UID, OTHER);
    expect(readVmToken(state, UID, () => undefined).toString("utf8")).toBe(OTHER);
    expect(readdirSync(dir())).toEqual([VM_TOKEN_FILE]);
  });
  it("clear: removes the file, then says there was none; status flips back to missing", () => {
    writeVmToken(state, UID, TOKEN);
    expect(clearVmToken(state, UID)).toBe(true);
    expect(status()).toBe("missing");
    expect(clearVmToken(state, UID)).toBe(false);
    expect(clearVmToken(path.join(state, "nowhere"), UID)).toBe(false);
  });
  it("status gives the file's age in whole days and the source", () => {
    writeVmToken(state, UID, TOKEN);
    const old = new Date(Date.now() - 10.5 * 86_400_000);
    utimesSync(file(), old, old);
    expect(vmTokenStatus(state, UID)).toEqual({ state: "present", ageDays: 10, source: "file" });
  });
  it("empty and wrong-shape files are unsafe, and the read gives no token", () => {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    for (const content of ["", "\n", "not-a-token", `sk-ant-api03-${"a".repeat(30)}`]) {
      writeFileSync(file(), content, { mode: 0o600 });
      expect(status()).toBe("unsafe");
      expect(readVmToken(state, UID, () => ENV_TOKEN).length).toBe(0);
    }
  });
});

describe("refusals (vm_token_unsafe), for the write and the read alike", () => {
  const both = (setup: () => void): void => {
    setup();
    expect(codeOf(() => writeVmToken(state, UID, OTHER))).toBe("vm_token_unsafe");
    expect(status()).toBe("unsafe");
    // Never a fall back to the environment variable, never the token.
    expect(readVmToken(state, UID, () => ENV_TOKEN).length).toBe(0);
  };
  beforeEach(() => writeVmToken(state, UID, TOKEN));

  it("a file at a mode wider than 0600", () => both(() => chmodSync(file(), 0o640)));
  it("a file others can write", () => both(() => chmodSync(file(), 0o666)));
  it("a link in place of the file", () => both(() => {
    const target = path.join(path.dirname(state), "elsewhere");
    writeFileSync(target, TOKEN, { mode: 0o600 });
    rmSync(file());
    symlinkSync(target, file());
  }));
  it("a FIFO in place of the file", () => both(() => {
    rmSync(file());
    execFileSync("mkfifo", ["-m", "600", file()]);
  }));
  it("a file with a second hard link", () => both(() => linkSync(file(), path.join(path.dirname(state), "second-name"))));
  it("an oversize file is unsafe to read, and a new token replaces it (the content is bad, not the file's mode or kind)", () => {
    writeFileSync(file(), `sk-ant-oat${"a".repeat(5000)}`, { mode: 0o600 });
    expect(status()).toBe("unsafe");
    expect(readVmToken(state, UID, () => ENV_TOKEN).length).toBe(0);
    writeVmToken(state, UID, OTHER);
    expect(status()).toBe("present");
  });
  it("a credentials directory open to the group", () => both(() => chmodSync(dir(), 0o750)));
  it("a credentials directory that is a link", () => both(() => {
    const moved = path.join(path.dirname(state), "moved");
    mkdirSync(moved, { mode: 0o700 });
    writeFileSync(path.join(moved, VM_TOKEN_FILE), TOKEN, { mode: 0o600 });
    rmSync(dir(), { recursive: true });
    symlinkSync(moved, dir());
  }));
  it("a state directory others can write", () => both(() => chmodSync(state, 0o777)));
  it("a state directory that is a link", () => both(() => {
    const link = path.join(path.dirname(state), "link");
    symlinkSync(state, link);
    state = link;
  }));
  it("a file or directory owned by someone else (the program runs as another user id)", () => {
    expect(codeOf(() => writeVmToken(state, UID + 1, OTHER))).toBe("vm_token_unsafe");
    expect(vmTokenStatus(state, UID + 1).state).toBe("unsafe");
  });
  it("a program that cannot tell its own user id", () => {
    expect(vmTokenStatus(state, undefined).state).toBe("unsafe");
    expect(codeOf(() => writeVmToken(state, undefined, TOKEN))).toBe("vm_token_unsafe");
  });
  it("an unsafe file is not changed by a refused write", () => {
    chmodSync(file(), 0o644);
    codeOf(() => writeVmToken(state, UID, OTHER));
    expect(readFileSync(file(), "utf8")).toBe(TOKEN);
  });
  it("a link is removed as a link by clear, never followed", () => {
    const target = path.join(path.dirname(state), "elsewhere");
    writeFileSync(target, TOKEN, { mode: 0o600 });
    rmSync(file());
    symlinkSync(target, file());
    expect(clearVmToken(state, UID)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(TOKEN);
  });
  it("no refusal's message holds the token or a path", () => {
    chmodSync(file(), 0o666);
    const message = ((): string => {
      try {
        writeVmToken(state, UID, OTHER);
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    })();
    expect(message).toMatch(/^vm_token_unsafe: /);
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(OTHER);
    expect(message).not.toContain(state);
  });
});

describe("readVmToken precedence", () => {
  it("the file wins over the environment variable", () => {
    writeVmToken(state, UID, TOKEN);
    expect(readVmToken(state, UID, () => ENV_TOKEN).toString("utf8")).toBe(TOKEN);
  });
  it("the variable is used only when the file is missing", () => {
    expect(readVmToken(state, UID, () => ENV_TOKEN).toString("utf8")).toBe(ENV_TOKEN);
    writeVmToken(state, UID, TOKEN);
    clearVmToken(state, UID);
    expect(readVmToken(state, UID, () => ENV_TOKEN).toString("utf8")).toBe(ENV_TOKEN);
  });
  it("neither gives an empty buffer, and each call gives a fresh buffer", () => {
    expect(readVmToken(state, UID, () => undefined).length).toBe(0);
    writeVmToken(state, UID, TOKEN);
    const a = readVmToken(state, UID, () => undefined);
    const b = readVmToken(state, UID, () => undefined);
    a.fill(0);
    expect(b.toString("utf8")).toBe(TOKEN);
  });
  it("a replaced token applies on the next read", () => {
    writeVmToken(state, UID, TOKEN);
    expect(readVmToken(state, UID, () => undefined).toString("utf8")).toBe(TOKEN);
    writeVmToken(state, UID, OTHER);
    expect(readVmToken(state, UID, () => undefined).toString("utf8")).toBe(OTHER);
  });
});

describe("the credentials verbs", () => {
  const run = async (words: string[], read?: () => Promise<string>): Promise<{ code: number; out: string[]; error?: unknown }> => {
    const out: string[] = [];
    const ctx = { stateDir: state, uid: UID, out: (line: string) => out.push(line), err: (line: string) => out.push(line) } as unknown as CommandContext;
    try {
      return { code: await credentialsCommand(words, ctx, undefined, read), out };
    } catch (error) {
      return { code: error instanceof CliError ? error.exitCode : 1, out, error };
    }
  };

  it("set-vm-token reads the token from the reader, stores it, and prints no part of it", async () => {
    const result = await run(["set-vm-token"], async () => `${TOKEN}\n`);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).not.toContain("FAKETOKEN");
    expect(readFileSync(file(), "utf8")).toBe(TOKEN);
  });
  it("set-vm-token with an argument exits non-zero with fixed text, stores nothing and never reads", async () => {
    let read = false;
    const result = await run(["set-vm-token", TOKEN], async () => ((read = true), TOKEN));
    expect(result.code).toBe(2);
    expect(read).toBe(false);
    expect((result.error as Error).message).toBe(VM_TOKEN_USAGE);
    expect(() => lstatSync(dir())).toThrow();
  });
  it("a bad token from the reader stores nothing", async () => {
    const result = await run(["set-vm-token"], async () => "garbage");
    expect(result.code).not.toBe(0);
    expect(String((result.error as Error).message)).toMatch(/^vm_token_format: /);
    expect(() => lstatSync(dir())).toThrow();
  });
  it("vm-token-status prints present with the age and source, missing, and unsafe, never any of the token", async () => {
    expect((await run(["vm-token-status"])).out).toEqual(["missing"]);
    writeVmToken(state, UID, TOKEN);
    expect((await run(["vm-token-status"])).out).toEqual(["present (file, set 0 days ago)"]);
    chmodSync(file(), 0o644);
    expect((await run(["vm-token-status"])).out).toEqual(["unsafe"]);
  });
  it("clear-vm-token removes the file and is idempotent", async () => {
    writeVmToken(state, UID, TOKEN);
    expect((await run(["clear-vm-token"])).out[0]).toMatch(/removed/);
    expect((await run(["clear-vm-token"])).out[0]).toMatch(/No VM token/);
    expect(status()).toBe("missing");
  });
});

describe("reading the token with no echo", () => {
  const tty = (): SecretStream & PassThrough & { raw: boolean[] } => {
    const stream = new PassThrough() as SecretStream & PassThrough & { raw: boolean[] };
    stream.isTTY = true;
    stream.raw = [];
    stream.setRawMode = (mode) => stream.raw.push(mode);
    return stream;
  };
  it("the prompt names the mint command to run yourself and the scrollback to clear", () => {
    expect(VM_TOKEN_PROMPT).toMatch(/run: claude setup-token/);
    expect(VM_TOKEN_PROMPT).toMatch(/scrollback/);
  });
  it("piped input is read to its end", async () => {
    const stream = new PassThrough();
    const read = readSecret(stream, () => undefined, VM_TOKEN_MAX);
    stream.end(`${TOKEN}\n`);
    expect(await read).toBe(`${TOKEN}\n`);
  });
  it("on a terminal echo is switched off and only the prompt and a newline are written", async () => {
    const stream = tty();
    const said: string[] = [];
    const read = readSecret(stream, (text) => said.push(text), VM_TOKEN_MAX, { prompt: VM_TOKEN_PROMPT });
    stream.write(`${TOKEN}\r`);
    expect(await read).toBe(TOKEN);
    expect(stream.raw).toEqual([true, false]);
    expect(said).toEqual([VM_TOKEN_PROMPT, "\n"]);
    expect(said.join("")).not.toContain("FAKETOKEN");
  });
  it("input far past the limit is refused early with the format code", async () => {
    const stream = new PassThrough();
    const read = readSecret(stream, () => undefined, VM_TOKEN_MAX, { tooLong: () => new VmTokenError("vm_token_format") });
    stream.write("a".repeat(VM_TOKEN_MAX + 10));
    await expect(read).rejects.toMatchObject({ code: "vm_token_format" });
  });
});

describe("the remedy matches the problem", () => {
  const messageOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };
  it("a file problem says to clear the token and set it again", () => {
    writeVmToken(state, UID, TOKEN);
    chmodSync(file(), 0o644);
    const message = messageOf(() => writeVmToken(state, UID, OTHER));
    expect(message).toContain("clear-vm-token");
    expect(message).toContain("set-vm-token");
  });
  it("a credentials directory at 0750 names the directory and chmod 700, and following that advice ends at present", () => {
    writeVmToken(state, UID, TOKEN);
    chmodSync(dir(), 0o750);
    const message = messageOf(() => writeVmToken(state, UID, OTHER));
    expect(message).toMatch(/credentials directory/);
    expect(message).toContain("chmod 700");
    expect(message).not.toContain("clear-vm-token");
    expect(status()).toBe("unsafe");
    chmodSync(dir(), 0o700); // the printed advice
    writeVmToken(state, UID, OTHER);
    expect(status()).toBe("present");
    expect(readVmToken(state, UID, () => undefined).toString("utf8")).toBe(OTHER);
  });
  it("a group-writable state directory names chmod go-w, and following it ends at present", () => {
    writeVmToken(state, UID, TOKEN);
    chmodSync(state, 0o770);
    const message = messageOf(() => writeVmToken(state, UID, OTHER));
    expect(message).toContain("state directory");
    expect(message).toContain("chmod go-w");
    chmodSync(state, 0o700);
    expect(status()).toBe("present");
  });
});

describe("a swap between the lstat and the open (each defence has its own test)", () => {
  const spec = (hook: () => void): SecretFileSpec => ({ ...VM_TOKEN_SPEC, betweenLstatAndOpen: hook });
  const reasonOf = (hook: () => void): string => {
    try {
      readSecretFile(spec(hook), state, UID);
    } catch (error) {
      return (error as Error).message;
    }
    return "read succeeded";
  };
  beforeEach(() => writeVmToken(state, UID, TOKEN));

  it("a link put in place of the file is refused by the no-follow open (not by a later check)", () => {
    const target = path.join(path.dirname(state), "elsewhere");
    writeFileSync(target, OTHER, { mode: 0o600 });
    expect(reasonOf(() => { rmSync(file()); symlinkSync(target, file()); })).toContain("the file cannot be opened");
  });
  it("a different plain file put in place of the file is refused by the inode check", () => {
    const other = path.join(dir(), "other");
    writeFileSync(other, OTHER, { mode: 0o600 });
    expect(reasonOf(() => renameSync(other, file()))).toContain("the file changed while it was being read");
  });
  it("the same file made readable by others is refused by the check on the open handle", () => {
    expect(reasonOf(() => chmodSync(file(), 0o644))).toContain("the file can be read by other users");
  });
  it("with no swap the read succeeds", () => {
    expect(readSecretFile(spec(() => undefined), state, UID).toString("utf8")).toBe(TOKEN);
  });
});
