// apps/workspace/test/forbidden-signin.test.mjs
//
// D#37 WS-C2 criterion 9 (CWE-522, Insufficiently Protected
// Credentials): checks.mjs --ship's forbidden-signin rules
// (rules.mjs's checkShipForbiddenSignin) fail the build if the shipped
// fork's bytes contain the legacy local-auth endpoints, the magic-link
// email flow, or a password-shaped input -- the exact strings D#37
// WS-C2 criterion 9 names. Every fixture here is invented for this
// test.

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { checkShipForbiddenSignin, SHIP_PASSWORD_INPUT_ALLOWED_PATHS } from "../import/rules.mjs";
import { checkTree } from "../import/checks.mjs";

const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length > 0) {
    rmSync(cleanupDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

describe("checkShipForbiddenSignin: each rule fires on its own fixture", () => {
  it("flags /api/login", () => {
    expect(checkShipForbiddenSignin(Buffer.from("fetch('/api/login', opts)"))).toContain("ship-forbidden-login-path");
  });

  it("flags /api/signup", () => {
    expect(checkShipForbiddenSignin(Buffer.from("fetch('/api/signup')"))).toContain("ship-forbidden-signup-path");
  });

  it("flags /api/local-auto-login", () => {
    expect(checkShipForbiddenSignin(Buffer.from("fetch('/api/local-auto-login')"))).toContain(
      "ship-forbidden-local-auto-login-path",
    );
  });

  it("flags the magic-link request path", () => {
    expect(checkShipForbiddenSignin(Buffer.from("fetch('/api/cloud/auth/magic/request')"))).toContain(
      "ship-forbidden-magic-request-path",
    );
  });

  it("flags a literal HTML password input", () => {
    expect(checkShipForbiddenSignin(Buffer.from('<input type="password" id="pw">'))).toContain(
      "ship-forbidden-password-input",
    );
  });

  it("flags a JS-constructed password input", () => {
    expect(checkShipForbiddenSignin(Buffer.from("el.type = 'password';"))).toContain("ship-forbidden-password-input");
  });

  it("does not flag ordinary, unrelated code", () => {
    expect(checkShipForbiddenSignin(Buffer.from("fetch('/api/mode').then(r => r.json())"))).toEqual([]);
    expect(checkShipForbiddenSignin(Buffer.from("<input type=\"text\" id=\"cloud-login-email\">"))).toEqual([]);
    expect(checkShipForbiddenSignin(Buffer.from("const password = 'not a real assignment, just this word';"))).toEqual(
      [],
    );
  });
});

// D#37 C34 section 1 (WS-F5p): one exact-path, first-party-only exemption.
describe("checkShipForbiddenSignin: the Model Key password-input exemption", () => {
  const PW = Buffer.from('<input type="password" id="k">');
  const EXEMPT = "apps/model-key/model-key-app.js";

  it("does not flag a password input at the exempt path when first-party", () => {
    expect(checkShipForbiddenSignin(PW, { relPath: EXEMPT, firstParty: true })).toEqual([]);
    expect(checkShipForbiddenSignin(Buffer.from('({ type: "password" })'), { relPath: EXEMPT, firstParty: true })).toEqual([]);
  });

  it.each([
    "apps/model-key/other.js",
    "apps/developer/developer-app.js",
    "apps/model-key/model-key-app.js.bak",
    "apps/model-key/model-key-app.jsx",
    "x/apps/model-key/model-key-app.js",
    "apps/model-key/MODEL-KEY-APP.js",
    "core/cloud-login.js",
  ])("still flags the same bytes at %s, first-party", (relPath) => {
    expect(checkShipForbiddenSignin(PW, { relPath, firstParty: true })).toContain("ship-forbidden-password-input");
  });

  it("still flags the exempt path when it is not first-party (imported/legacy)", () => {
    expect(checkShipForbiddenSignin(PW, { relPath: EXEMPT, firstParty: false })).toContain("ship-forbidden-password-input");
    expect(checkShipForbiddenSignin(PW, { relPath: EXEMPT })).toContain("ship-forbidden-password-input");
  });

  it("still flags every other sign-in rule at the exempt path", () => {
    const buf = Buffer.from("fetch('/api/login'); fetch('/api/signup'); fetch('/api/local-auto-login'); fetch('magic/request');");
    expect(checkShipForbiddenSignin(buf, { relPath: EXEMPT, firstParty: true }).sort()).toEqual([
      "ship-forbidden-local-auto-login-path",
      "ship-forbidden-login-path",
      "ship-forbidden-magic-request-path",
      "ship-forbidden-signup-path",
    ]);
  });

  it("keeps the allowed-path list at exactly one frozen entry", () => {
    expect(SHIP_PASSWORD_INPUT_ALLOWED_PATHS).toEqual([EXEMPT]);
    expect(Object.isFrozen(SHIP_PASSWORD_INPUT_ALLOWED_PATHS)).toBe(true);
  });
});

describe("checks.mjs --ship: forbidden-signin rules run alongside the Claude Code gate", () => {
  it("a --ship tree with a forbidden path fails; --import does not run this rule", () => {
    const dir = scratchDir("ws-c2-forbidden-signin-");
    const file = join(dir, "core", "cloud-login.js");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "window.location = '/api/login';");

    const opts = { allowlistPatterns: [{ raw: "**", regex: /.*/ }], addedSet: new Set() };
    const shipViolations = checkTree(dir, { mode: "ship", ...opts });
    expect(shipViolations.map((v) => v.rule)).toContain("ship-forbidden-login-path");

    const importViolations = checkTree(dir, { mode: "import", ...opts });
    expect(importViolations.map((v) => v.rule)).not.toContain("ship-forbidden-login-path");
  });

  it("a clean --ship tree has zero forbidden-signin violations", () => {
    const dir = scratchDir("ws-c2-forbidden-signin-clean-");
    const file = join(dir, "core", "cloud-login.js");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "window.location = '/api/auth/github';");

    const opts = { allowlistPatterns: [{ raw: "**", regex: /.*/ }], addedSet: new Set() };
    const violations = checkTree(dir, { mode: "ship", ...opts });
    expect(violations.filter((v) => v.rule.startsWith("ship-forbidden-"))).toEqual([]);
  });
});
