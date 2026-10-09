// Pack lint: packs reach the app only through the fixtures and the shared client.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintPacks, lintSource, stripComments } from "../src/pack-lint.js";
import { PACKAGE_ROOT, tmpDir } from "./helpers.js";

const rulesOf = (text: string): string[] => lintSource("x.spec.ts", text).map((f) => f.rule);

const NON_ROUTE_FETCH = ".fetch( on anything but route";
const GLOBAL_FETCH = "globalThis.fetch / window.fetch / self.fetch";
const MEMBER_REQUEST = ".request. member (page.context().request, page.request, context.request)";
const STACK_IMPORT = "import of a network or process stack";
const CREATE_CLIENT = "createClient";
const PLAYWRIGHT_IMPORT = "@playwright/test import (use the fenced test fixture)";

describe("pack lint", () => {
  it("the real packs are clean", () => {
    expect(lintPacks(join(PACKAGE_ROOT, "packs"))).toEqual([]);
  });

  it("a planted fetch( in a fixture pack turns it red, naming file, line and rule", () => {
    const root = tmpDir("t1c_lint_");
    mkdirSync(join(root, "demo"), { recursive: true });
    writeFileSync(join(root, "demo", "demo.spec.ts"), 'import { test } from "../../fixtures/bypass.js";\ntest("x", async () => {\n  await fetch("https://example.test/");\n});\n');
    expect(lintPacks(root)).toEqual([{ file: join("demo", "demo.spec.ts"), line: 3, rule: "fetch(" }]);
  });

  // One line per case: each pattern is asserted on its own, so a rule that stops matching turns exactly its case red.
  it.each([
    ["request.newContext", "const c = await request.newContext();", "request.newContext"],
    ["bare fetch(", "await fetch(u);", "fetch("],
    ["bare fetch with a space", "await fetch (u);", "fetch("],
    ["fetch split across lines", "await fetch\n(u);", "fetch("],
    ["XMLHttpRequest", "const x = new XMLHttpRequest();", "XMLHttpRequest"],
    ["browser.newContext", "const c = await browser.newContext();", "browser.newContext / newPage"],
    ["browser.newPage", "const p = await browser.newPage();", "browser.newContext / newPage"],
    ["own browser launch", "const b = await chromium.launch();", "own browser launch"],
    ["built-in request fixture", 'test("x", async ({ request }) => {});', "built-in request fixture"],
    ["built-in request fixture among others", 'test("x", async ({ page, request, api }) => {});', "built-in request fixture"],
  ])("flags %s", (_name, text, rule) => {
    expect(rulesOf(text)).toContain(rule);
  });

  it.each([
    ["page.context().request.post", "await page.context().request.post(u);"],
    ["page.request.get", "await page.request.get(u);"],
    ["context.request.post", "await context.request.post(u);"],
    ["fx.request.get", "await fx.request.get(u);"],
    ["playwright.request.get", "await playwright.request.get(u);"],
    ["request across a line break", "await page.context()\n  .request\n  .post(u);"],
  ])("flags a .request. member: %s", (_name, text) => {
    expect(rulesOf(text)).toContain(MEMBER_REQUEST);
  });

  it.each([
    ["page.request as a value", "const r = page.request;"],
    ["context.request as a value", "const r = context.request;"],
  ])("flags %s", (_name, text) => {
    expect(rulesOf(text)).toContain("page.request / context.request");
  });

  it.each([
    ["globalThis.fetch as a value", "const f = globalThis.fetch;"],
    ["window.fetch as a value", "const f = window.fetch;"],
    ["self.fetch as a value", "const f = self.fetch;"],
    ["globalThis.fetch(", "await globalThis.fetch(u);"],
    ["window.fetch(", "await window.fetch(u);"],
    ["self.fetch(", "await self.fetch(u);"],
    ["globalThis.fetch with spaces", "await globalThis . fetch (u);"],
    ["globalThis.fetch across lines", "await globalThis\n  .fetch(u);"],
  ])("flags %s", (_name, text) => {
    expect(rulesOf(text)).toContain(GLOBAL_FETCH);
  });

  it.each([
    ["page.fetch(", "await page.fetch(u);"],
    ["self.client.fetch(", "await self.client.fetch(u);"],
    ["a call result's fetch(", "await getClient().fetch(u);"],
    ["an element's fetch(", "await clients[0].fetch(u);"],
    ["route.context.fetch(", "await route.context.fetch(u);"],
    ["fetch( after a line break", "await thing\n  .fetch(u);"],
  ])("flags .fetch( whose receiver is not route: %s", (_name, text) => {
    expect(rulesOf(text)).toContain(NON_ROUTE_FETCH);
  });

  it("route.fetch( is the one .fetch( that is allowed", () => {
    expect(rulesOf("await route.fetch({ maxRedirects: 0 });")).toEqual([]);
    expect(rulesOf("await route\n  .fetch(opts);")).toEqual([]);
    expect(rulesOf("await xroute.fetch(opts);")).toContain(NON_ROUTE_FETCH);
  });

  it.each([
    ["from node:http", 'import x from "node:http";'],
    ["from node:https", 'import x from "node:https";'],
    ["from http", 'import x from "http";'],
    ["from https", 'import x from "https";'],
    ["from node:http2", 'import x from "node:http2";'],
    ["from http2", 'import x from "http2";'],
    ["from node:net", 'import x from "node:net";'],
    ["from net", 'import x from "net";'],
    ["from node:tls", 'import x from "node:tls";'],
    ["from tls", 'import x from "tls";'],
    ["from node:child_process", 'import { spawn } from "node:child_process";'],
    ["from child_process", 'import { spawn } from "child_process";'],
    ["from undici", 'import x from "undici";'],
    ["from axios", 'import axios from "axios";'],
    ["from node-fetch", 'import nodeFetch from "node-fetch";'],
    ["from ws", 'import WebSocket from "ws";'],
    ["from a subpath", 'import x from "undici/types";'],
    ["side-effect import", 'import "node:net";'],
    ["require", 'const net = require("node:net");'],
    ["dynamic import", 'const h = await import("node:https");'],
  ])("flags an import of a network or process stack: %s", (_name, text) => {
    expect(rulesOf(text)).toContain(STACK_IMPORT);
  });

  it.each([
    ["an import", 'import { createClient } from "../../src/client.js";'],
    ["an aliased import", 'import { createClient as make } from "../../src/client.js";'],
    ["a call", "const c = createClient({ origin: o });"],
    ["a call across lines", "const c = createClient\n  ({ origin: o });"],
    ["a namespace member", 'const c = client.createClient({ origin: o });'],
  ])("flags createClient in pack code: %s", (_name, text) => {
    expect(rulesOf(text)).toContain(CREATE_CLIENT);
  });

  it.each([
    ["named test", 'import { test } from "@playwright/test";'],
    ["test among others", 'import { expect, test } from "@playwright/test";'],
    ["aliased test", 'import { test as base } from "@playwright/test";'],
    ["default or namespace", 'import * as pw from "@playwright/test";'],
    ["multi-line", 'import {\n  test,\n  expect,\n} from "@playwright/test";'],
    ["single quotes", "import { test } from '@playwright/test';"],
    ["re-export", 'export { test } from "@playwright/test";'],
    ["side-effect import", 'import "@playwright/test";'],
    ["a subpath", 'import { test } from "@playwright/test/lib";'],
    ["require", 'const { test } = require("@playwright/test");'],
    ["dynamic import", 'const pw = await import("@playwright/test");'],
  ])("flags an import of @playwright/test: %s", (_name, text) => {
    expect(rulesOf(text)).toContain(PLAYWRIGHT_IMPORT);
  });

  it("allows a type-only import of @playwright/test, and the fixtures module for test and expect", () => {
    expect(rulesOf('import type { Page } from "@playwright/test";')).toEqual([]);
    expect(rulesOf('import { expect, test } from "../../fixtures/bypass.js";')).toEqual([]);
    expect(rulesOf('import { test } from "@playwright/test-helpers";')).toEqual([]);
    expect(rulesOf("const createClients = 1; recreateClient();")).toEqual([]);
  });

  it("leaves the sanctioned paths and look-alikes alone", () => {
    expect(rulesOf('test("x", async ({ page, api, anon, target }) => { await api.get("/"); await page.goto("/"); });')).toEqual([]);
    expect(rulesOf("const prefetch = 1; refetch(); myfetch(1); x.fetchAll();")).toEqual([]);
    expect(rulesOf('const label = "request";')).toEqual([]);
    expect(rulesOf('await api.request("/x", { method: "GET" });')).toEqual([]);
    expect(rulesOf('import { test } from "../../fixtures/bypass.js"; import x from "node:fs"; import y from "node:path";')).toEqual([]);
    expect(rulesOf('import w from "wss-helper"; import n from "network"; import t from "tlsx";')).toEqual([]);
  });

  it("ignores comments, keeping line numbers", () => {
    const text = "// fetch(x) is not allowed\n/* request.newContext()\n   fetch(y) */\nconst ok = 1;\nfetch(z);\n";
    expect(stripComments(text).split("\n")).toHaveLength(text.split("\n").length);
    expect(lintSource("a.ts", text)).toEqual([{ file: "a.ts", line: 5, rule: "fetch(" }]);
  });
});
