import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CURRENT_PROTOCOL_VERSION, HelloMessage, RUNNER_MESSAGES, RUNNER_NAME_MAX, RegisterMessage, RunnerFacts, isValidRunnerName } from "../src/messages.js";
import { nonStrictObjects } from "./helpers/schemaWalk.js";

const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;

/** D#605 FL-2, both directions (R-599-HO1). The "old" schemas are the strict shapes this change started from, pinned here so they cannot follow the new ones. */
const OLD_HELLO = z.object({ protocol_version: z.number().int().min(1), binary_version: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/), model_auth_present: z.boolean(), isolation: z.enum(["microvm", "vm_container", "container", "host_sandbox"]) }).strict();
const OLD_REGISTER = z.object({ code: z.string().regex(/^fxrr_[A-Za-z0-9]{32,128}$/), public_key_jwk: z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string() }).strict() }).strict();

describe("hello facts and the register name: compatibility in both directions", () => {
  it("an older runner's messages (pinned fixtures) are accepted unchanged by this cloud", () => {
    expect(HelloMessage.safeParse(fixture("hello-legacy.json")).success).toBe(true);
    expect(RegisterMessage.safeParse(fixture("register-legacy.json")).success).toBe(true);
    expect(OLD_HELLO.safeParse(fixture("hello-legacy.json")).success).toBe(true);
    expect(OLD_REGISTER.safeParse(fixture("register-legacy.json")).success).toBe(true);
  });

  it("a newer runner's messages (pinned fixtures) are accepted by this cloud", () => {
    const hello = HelloMessage.parse(fixture("hello-facts.json"));
    expect(hello.facts).toEqual({ os: "macos", arch: "arm64", mem_gb_bucket: 32, cpus: 12, sandbox_engine: "os_sandbox" });
    expect(RegisterMessage.parse(fixture("register-named.json")).name).toBe("Studio Mac");
  });

  it("a cloud that predates the fields refuses them as strict schemas do, which is why the cloud deploys first", () => {
    expect(OLD_HELLO.safeParse(fixture("hello-facts.json")).success).toBe(false);
    expect(OLD_REGISTER.safeParse(fixture("register-named.json")).success).toBe(false);
  });

  it("neither message gained a required field, and no reply changed", () => {
    expect(HelloMessage.shape.facts.isOptional()).toBe(true);
    expect(RegisterMessage.shape.name.isOptional()).toBe(true);
    expect(Object.keys(HelloMessage.shape).sort()).toEqual(["binary_version", "facts", "isolation", "model_auth_present", "protocol_version"]);
    expect(Object.keys(RegisterMessage.shape).sort()).toEqual(["code", "name", "public_key_jwk"]);
  });
});

describe("facts (criterion 1)", () => {
  const good = (fixture("hello-facts.json") as { facts: Record<string, unknown> }).facts;
  const hello = (facts: unknown) => HelloMessage.safeParse({ ...fixture("hello-legacy.json"), facts }).success;

  it("accepts every value of every enum and the cpu edges", () => {
    for (const os of ["linux", "macos"]) expect(hello({ ...good, os }), os).toBe(true);
    for (const arch of ["x64", "arm64"]) expect(hello({ ...good, arch }), arch).toBe(true);
    for (const sandbox_engine of ["os_sandbox", "microvm"]) expect(hello({ ...good, sandbox_engine }), sandbox_engine).toBe(true);
    for (const mem_gb_bucket of [4, 8, 16, 32, 64, 128]) expect(hello({ ...good, mem_gb_bucket }), String(mem_gb_bucket)).toBe(true);
    for (const cpus of [1, 256]) expect(hello({ ...good, cpus }), String(cpus)).toBe(true);
  });

  it("refuses an unknown key, a missing key, and any value outside its enum or range", () => {
    expect(hello({ ...good, hostname: "box" })).toBe(false);
    for (const key of Object.keys(good)) expect(hello(Object.fromEntries(Object.entries(good).filter(([k]) => k !== key))), `missing ${key}`).toBe(false);
    for (const bad of [{ os: "windows" }, { os: "Linux" }, { arch: "arm" }, { arch: "x86_64" }, { mem_gb_bucket: 12 }, { mem_gb_bucket: 256 }, { mem_gb_bucket: "16" }, { cpus: 0 }, { cpus: 257 }, { cpus: 1.5 }, { cpus: "8" }, { sandbox_engine: "docker" }, { sandbox_engine: "" }]) {
      expect(hello({ ...good, ...bad }), JSON.stringify(bad)).toBe(false);
    }
    for (const notObject of [null, "linux", 1, [], [good]]) expect(hello(notObject), JSON.stringify(notObject)).toBe(false);
  });

  it("adds no free text: every leaf of facts is an enum, a literal set or a bounded integer (criterion 3)", () => {
    expect(nonStrictObjects(RunnerFacts)).toEqual([]);
    for (const [key, leaf] of Object.entries(RunnerFacts.shape)) {
      const closed = leaf instanceof z.ZodEnum || leaf instanceof z.ZodUnion || (leaf instanceof z.ZodNumber && leaf.minValue !== null && leaf.maxValue !== null && leaf.isInt);
      expect(closed, key).toBe(true);
    }
    expect(nonStrictObjects(RUNNER_MESSAGES.hello)).toEqual([]);
    expect(nonStrictObjects(RUNNER_MESSAGES.register)).toEqual([]);
  });
});

describe("the register name (criteria 2 and 3)", () => {
  const register = (name: unknown) => RegisterMessage.safeParse({ ...fixture("register-legacy.json"), name }).success;
  const cp = (...codes: number[]) => String.fromCodePoint(...codes);

  it("pins its maximum length at 64 characters, counted as characters and not UTF-16 units", () => {
    expect(RUNNER_NAME_MAX).toBe(64);
    expect(register("n".repeat(64))).toBe(true);
    expect(register("n".repeat(65))).toBe(false);
    expect(register("\u{1f600}".repeat(64))).toBe(true);
    expect(register("\u{1f600}".repeat(65))).toBe(false);
    expect(register("")).toBe(false);
  });

  it("refuses control, invisible and bidirectional characters and names that render as nothing", () => {
    for (const name of ["a\u0007b", "a\nb", "a\tb\u007f", "a\u0085b", "a​b", "a‮b", "a⁦b", "a­b", "a﻿b", cp(0xe0020) + "a", "   ", cp(0xa0), cp(0x3000), cp(0x2800), cp(0x3164)]) {
      expect(register(name), JSON.stringify(name)).toBe(false);
      expect(isValidRunnerName(name), JSON.stringify(name)).toBe(false);
    }
    expect(register(7)).toBe(false);
    expect(register(null)).toBe(false);
  });

  it("refuses a lone UTF-16 surrogate, which would be stored as U+FFFD, and accepts a whole pair", () => {
    for (const name of ["a\ud800b", "\udc00", "ab\udbff", "\ude00\ud83d", "x\ud83d"]) expect(register(name), JSON.stringify(name)).toBe(false);
    expect(register("a\u{1f600}b")).toBe(true);
  });

  it("accepts names with spaces, unicode and punctuation", () => {
    for (const name of ["Desktop", "Büro Desktop (2nd floor)", "ホームサーバー", "vps-01.example.net", `${cp(0x2800)}x`, `a${cp(0xa0)}b`]) expect(register(name), name).toBe(true);
  });
});

describe("one protocol version", () => {
  it("is a single constant in the protocol package, which the cloud re-exports and the runner sends on hello", async () => {
    expect(CURRENT_PROTOCOL_VERSION).toBe(1);
    const { readFileSync: read } = await import("node:fs");
    const cloud = read(new URL("../../runner-cloud/src/http.ts", import.meta.url), "utf8");
    const runner = read(new URL("../../fx-runner/src/version.ts", import.meta.url), "utf8");
    expect(cloud).not.toMatch(/CURRENT_PROTOCOL_VERSION\s*=\s*\d/);
    expect(runner).not.toMatch(/PROTOCOL_VERSION[^=\n]*=\s*\d/);
    expect(runner).toMatch(/RUNNER_PROTOCOL_VERSION: number = CURRENT_PROTOCOL_VERSION/);
  });
});
