import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_KEY_FILE, API_KEY_MAX_BYTES, CREDENTIALS_DIR, ApiKeyError, clearApiKey, parseApiKey, perJobApiKey, readApiKey, writeApiKey } from "../src/credentials.js";
import { readSecret, type SecretStream } from "../src/secretInput.js";

// Assembled from fragments so no token-shaped literal sits in the source.
const KEY = ["sk-ant-", "api03-", "FAKEKEY0123456789abcdef"].join("");
const OTHER = ["sk-ant-", "api03-", "SECONDKEY9876543210zyxwv"].join(""); // gitleaks:allow
const UID = process.getuid!();

let state: string;
beforeEach(() => {
  state = path.join(mkdtempSync(path.join(tmpdir(), "fxr-cred-")), "state");
});
afterEach(() => rmSync(path.dirname(state), { recursive: true, force: true }));

const dir = (): string => path.join(state, CREDENTIALS_DIR);
const file = (): string => path.join(dir(), API_KEY_FILE);
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof ApiKeyError ? error.code : `not an ApiKeyError: ${String(error)}`;
  }
  return undefined;
};

describe("what a key may look like (api_key_format)", () => {
  it("takes a key with one trailing newline", () => {
    expect(parseApiKey(`${KEY}\n`)).toBe(KEY);
    expect(parseApiKey(`${KEY}\r\n`)).toBe(KEY);
  });
  it.each([
    ["empty", ""],
    ["only a newline", "\n"],
    ["only the prefix", "sk-ant-"],
    ["no prefix", "abcdefghijklmnop"],
    ["over 256 bytes", `sk-ant-${"a".repeat(API_KEY_MAX_BYTES)}`],
    ["a space", `${KEY} x`],
    ["a second line", `${KEY}\nmore`],
    ["a control byte", `${KEY}\u0001`],
    ["a byte over 126", `${KEY}é`],
  ])("refuses %s, and the message holds no part of the value", (_name, value) => {
    let message = "";
    try {
      parseApiKey(value);
    } catch (error) {
      expect((error as ApiKeyError).code).toBe("api_key_format");
      message = (error as Error).message;
    }
    expect(message).toMatch(/^api_key_format: /);
    expect(message).not.toContain("abcdefghijklmnop");
  });
  it("accepts exactly 256 bytes", () => {
    expect(parseApiKey(`sk-ant-${"a".repeat(API_KEY_MAX_BYTES - 7)}`)).toHaveLength(API_KEY_MAX_BYTES);
  });
});

describe("writing and reading", () => {
  it("writes a 0600 file in a 0700 directory, holding the key and nothing else, and leaves no temporary file", () => {
    writeApiKey(state, UID, `${KEY}\n`);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(statSync(dir()).mode & 0o777).toBe(0o700);
    expect(readFileSync(file(), "utf8")).toBe(KEY);
    expect(readdirSync(dir())).toEqual([API_KEY_FILE]);
    expect(readApiKey(state, UID)).toBe(KEY);
  });
  it("replaces the key in one rename", () => {
    writeApiKey(state, UID, KEY);
    writeApiKey(state, UID, OTHER);
    expect(readApiKey(state, UID)).toBe(OTHER);
    expect(readdirSync(dir())).toEqual([API_KEY_FILE]);
  });
  it("a bad key writes nothing", () => {
    expect(codeOf(() => writeApiKey(state, UID, "nope"))).toBe("api_key_format");
    expect(() => lstatSync(dir())).toThrow();
  });
  it("nothing stored is api_key_not_configured, at every level", () => {
    expect(codeOf(() => readApiKey(state, UID))).toBe("api_key_not_configured");
    mkdirSync(state, { mode: 0o700 });
    expect(codeOf(() => readApiKey(state, UID))).toBe("api_key_not_configured");
    mkdirSync(dir(), { mode: 0o700 });
    expect(codeOf(() => readApiKey(state, UID))).toBe("api_key_not_configured");
  });
});

describe("refusals (api_key_unsafe), for the write and the read alike", () => {
  const both = (setup: () => void): void => {
    setup();
    expect(codeOf(() => writeApiKey(state, UID, OTHER))).toBe("api_key_unsafe");
    expect(codeOf(() => readApiKey(state, UID))).toBe("api_key_unsafe");
  };
  beforeEach(() => writeApiKey(state, UID, KEY));

  it("a file at a mode wider than 0600", () => both(() => chmodSync(file(), 0o640)));
  it("a file others can write", () => both(() => chmodSync(file(), 0o666)));
  it("a link in place of the file", () => both(() => {
    const target = path.join(path.dirname(state), "elsewhere");
    writeFileSync(target, KEY, { mode: 0o600 });
    rmSync(file());
    symlinkSync(target, file());
  }));
  it("a file with a second hard link", () => both(() => linkSync(file(), path.join(path.dirname(state), "second-name"))));
  it("a credentials directory open to the group", () => both(() => chmodSync(dir(), 0o750)));
  it("a credentials directory that is a link", () => both(() => {
    const moved = path.join(path.dirname(state), "moved");
    mkdirSync(moved, { mode: 0o700 });
    writeFileSync(path.join(moved, API_KEY_FILE), KEY, { mode: 0o600 });
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
    expect(codeOf(() => writeApiKey(state, UID + 1, OTHER))).toBe("api_key_unsafe");
    expect(codeOf(() => readApiKey(state, UID + 1))).toBe("api_key_unsafe");
  });
  it("a program that cannot tell its own user id", () => {
    expect(codeOf(() => readApiKey(state, undefined))).toBe("api_key_unsafe");
    expect(codeOf(() => writeApiKey(state, undefined, KEY))).toBe("api_key_unsafe");
  });
  it("a file that was not changed by a refused write", () => {
    chmodSync(file(), 0o644);
    codeOf(() => writeApiKey(state, UID, OTHER));
    expect(readFileSync(file(), "utf8")).toBe(KEY);
  });
  it("a key file holding something that is not a key is api_key_format", () => {
    writeFileSync(file(), "not-a-key", { mode: 0o600 });
    expect(codeOf(() => readApiKey(state, UID))).toBe("api_key_format");
    writeFileSync(file(), `sk-ant-${"a".repeat(400)}`, { mode: 0o600 });
    expect(codeOf(() => readApiKey(state, UID))).toBe("api_key_format");
  });
  it("no refusal's message holds the key", () => {
    chmodSync(file(), 0o644);
    for (const fn of [() => readApiKey(state, UID), () => writeApiKey(state, UID, OTHER)]) {
      try {
        fn();
      } catch (error) {
        expect(String((error as Error).message) + String((error as Error).stack)).not.toMatch(/FAKEKEY|SECONDKEY/);
      }
    }
  });
});

describe("clearing", () => {
  it("removes the file, and says so only when there was one", () => {
    writeApiKey(state, UID, KEY);
    expect(clearApiKey(state, UID)).toBe(true);
    expect(clearApiKey(state, UID)).toBe(false);
    expect(codeOf(() => readApiKey(state, UID))).toBe("api_key_not_configured");
  });
  it("is false when there is no state at all", () => {
    expect(clearApiKey(state, UID)).toBe(false);
  });
  it("removes a link in place of the file without touching its target", () => {
    writeApiKey(state, UID, KEY);
    const target = path.join(path.dirname(state), "target");
    writeFileSync(target, "keep", { mode: 0o600 });
    rmSync(file());
    symlinkSync(target, file());
    expect(clearApiKey(state, UID)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });
});

describe("the key a job gets (read at the start of each job)", () => {
  it("is the file's content at that moment: a replaced key reaches the next job, a deleted file leaves none", () => {
    writeApiKey(state, UID, KEY);
    const live = perJobApiKey(state, UID);
    expect(() => live.credentials.mode === "api_key" && live.credentials.apiKey).not.toThrow();
    live.refresh();
    expect(live.credentials).toMatchObject({ mode: "api_key", apiKey: KEY });
    writeApiKey(state, UID, OTHER);
    expect(live.credentials).toMatchObject({ apiKey: KEY });
    live.refresh();
    expect(live.credentials).toMatchObject({ apiKey: OTHER });
    clearApiKey(state, UID);
    expect(codeOf(() => live.refresh())).toBe("api_key_not_configured");
    expect(live.credentials).toMatchObject({ apiKey: "" });
  });
  it("shows only its mode to a JSON dump, a spread or a listing of its properties", () => {
    writeApiKey(state, UID, KEY);
    const live = perJobApiKey(state, UID);
    live.refresh();
    expect(JSON.stringify(live.credentials)).toBe('{"mode":"api_key"}');
    expect(Object.keys({ ...live.credentials })).toEqual(["mode"]);
    expect(JSON.stringify(Object.entries(live.credentials))).not.toContain("FAKEKEY");
  });
});

describe("reading the key from standard input", () => {
  const tty = (): SecretStream & PassThrough & { raw: boolean[] } => {
    const stream = new PassThrough() as SecretStream & PassThrough & { raw: boolean[] };
    stream.isTTY = true;
    stream.raw = [];
    stream.setRawMode = (mode) => stream.raw.push(mode);
    return stream;
  };
  it("takes piped input to its end", async () => {
    const stream = new PassThrough();
    const read = readSecret(stream, () => undefined, API_KEY_MAX_BYTES);
    stream.write(KEY.slice(0, 10));
    stream.end(`${KEY.slice(10)}\n`);
    expect(await read).toBe(`${KEY}\n`);
  });
  it("stops reading at once when the input is longer than a key can be", async () => {
    const stream = new PassThrough();
    const read = readSecret(stream, () => undefined, API_KEY_MAX_BYTES);
    stream.write("a".repeat(API_KEY_MAX_BYTES + 10));
    await expect(read).rejects.toMatchObject({ code: "api_key_format" });
  });
  it("on a terminal switches echo off, writes only the prompt and a newline, honours backspace and ends at Enter", async () => {
    const stream = tty();
    const said: string[] = [];
    const read = readSecret(stream, (text) => said.push(text), API_KEY_MAX_BYTES);
    stream.write(`${KEY}X`);
    stream.write("\u007f\r");
    expect(await read).toBe(KEY);
    expect(stream.raw).toEqual([true, false]);
    expect(said).toHaveLength(2);
    expect(said.join("")).not.toContain("FAKEKEY");
    expect(said[1]).toBe("\n");
  });
  it("Ctrl-C cancels and restores the terminal", async () => {
    const stream = tty();
    const read = readSecret(stream, () => undefined, API_KEY_MAX_BYTES);
    stream.write("sk-\u0003");
    await expect(read).rejects.toMatchObject({ exitCode: 130 });
    expect(stream.raw).toEqual([true, false]);
  });
  it("a terminal that cannot switch echo off is refused rather than read with echo", async () => {
    const stream = new PassThrough() as SecretStream;
    stream.isTTY = true;
    await expect(readSecret(stream, () => undefined, API_KEY_MAX_BYTES)).rejects.toThrow(/echo/);
  });
});
