import { generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { configureErrorReporter, type ErrorClass } from "@fx/telemetry";
import { GIT_TICKET_KEY_ID_ENV, GIT_TICKET_SIGNING_KEY_ENV, loadGitTicketSigner } from "../src/gitTicketSigner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { privateKey } = generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const RSA = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/** D#6 R5a-2b (C27 section 1.6, section 5 required settings): the ticket key is read in one place, and a bad setting turns the route off without stopping the worker. */
describe("loadGitTicketSigner", () => {
  const reported: ErrorClass[] = [];
  beforeEach(() => {
    reported.length = 0;
    configureErrorReporter({ service: "app", write: () => undefined, sink: { record: (event) => void reported.push(event) } });
  });

  it("is null, and silent, when neither setting is present", () => {
    expect(loadGitTicketSigner({})).toBeNull();
    expect(loadGitTicketSigner({ [GIT_TICKET_SIGNING_KEY_ENV]: "  ", [GIT_TICKET_KEY_ID_ENV]: "" })).toBeNull();
    expect(reported).toEqual([]);
  });

  it("builds a signer from an Ed25519 PEM and an id, accepting a one-line PEM with literal backslash-n", () => {
    const signer = loadGitTicketSigner({ [GIT_TICKET_SIGNING_KEY_ENV]: PEM, [GIT_TICKET_KEY_ID_ENV]: "k1" });
    expect(signer?.keyId).toBe("k1");
    expect(signer?.privateKey.asymmetricKeyType).toBe("ed25519");
    expect(loadGitTicketSigner({ [GIT_TICKET_SIGNING_KEY_ENV]: PEM.trim().replace(/\n/g, "\\n"), [GIT_TICKET_KEY_ID_ENV]: "k1" })).not.toBeNull();
    expect(reported).toEqual([]);
  });

  it("is null and reported, never thrown, when only one is set or a value is invalid (the sandbox path must keep working)", () => {
    for (const env of [
      { [GIT_TICKET_SIGNING_KEY_ENV]: PEM },
      { [GIT_TICKET_KEY_ID_ENV]: "k1" },
      { [GIT_TICKET_SIGNING_KEY_ENV]: PEM, [GIT_TICKET_KEY_ID_ENV]: "has space" },
      { [GIT_TICKET_SIGNING_KEY_ENV]: PEM, [GIT_TICKET_KEY_ID_ENV]: "x".repeat(65) },
      { [GIT_TICKET_SIGNING_KEY_ENV]: RSA, [GIT_TICKET_KEY_ID_ENV]: "k1" },
      { [GIT_TICKET_SIGNING_KEY_ENV]: "not a pem", [GIT_TICKET_KEY_ID_ENV]: "k1" },
    ]) {
      reported.length = 0;
      expect(loadGitTicketSigner(env), JSON.stringify(Object.keys(env))).toBeNull();
      expect(reported, JSON.stringify(Object.keys(env))).toHaveLength(1);
      expect(reported[0]!.stage).toBe("runner.git_ticket_config");
    }
  });

  it("the report names the variable and holds no part of the key", () => {
    const lines: string[] = [];
    configureErrorReporter({ service: "app", write: (line) => void lines.push(line) });
    loadGitTicketSigner({ [GIT_TICKET_SIGNING_KEY_ENV]: "super-secret-not-a-pem", [GIT_TICKET_KEY_ID_ENV]: "k1" });
    expect(lines.join("\n")).not.toContain("super-secret");
  });
});

describe("the ticket key settings are read in one place", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("only the worker's signer loader and the env manifest spell the two names; no other source file does", () => {
    const root = path.join(HERE, "..", "..", "..");
    const sources = [...walk(path.join(root, "packages")), ...walk(path.join(root, "apps"))].filter((f) => !/(^|\/)test\/|\.test\.tsx?$/.test(path.relative(root, f).split(path.sep).join("/")));
    const files = sources.filter((f) => /FX_GIT_TICKET_(SIGNING_KEY_PEM|KEY_ID)/.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f).split(path.sep).join("/")).sort();
    expect(files).toEqual(["apps/web/env-manifest.ts", "packages/worker/src/gitTicketSigner.ts"]);
  });
});
