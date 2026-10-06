#!/usr/bin/env node
// apps/workspace/perf/boot-timing.mjs
//
// Measurement only (D#37 boot-budget cap review): cold signed-in boot to
// "desktop usable" (the boot:desktop-ready mark) on an emulated low-end
// phone -- 412x915 touch, CPU x4, Slow-4G network (150 ms, 1.6 Mbit/s, the
// same profile e2e/boot-budget.spec.ts uses) -- with brotli responses from
// perf/brotli-proxy.mjs. Compares the built dist/ against a scratch copy
// with EXTRA_KB of incompressible padding appended to a boot script. The
// padding lives only in a temp dir; nothing is written into dist/.
//
//   node build/build.mjs && node perf/boot-timing.mjs [--runs 7] [--extra-kb 70]

import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, appendFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { brotliCompressSync, constants } from "node:zlib";
import { chromium } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const RUNS = arg("runs", 7);
const EXTRA_KB = arg("extra-kb", 70);

const children = [];
function serve(distDir, fixturePort, proxyPort) {
  children.push(spawn("node", [join(ROOT, "e2e/fixture-server.mjs"), "--dist", distDir, "--port", String(fixturePort)], { cwd: ROOT, stdio: "ignore" }));
  children.push(spawn("node", [join(HERE, "brotli-proxy.mjs"), "--upstream", `http://127.0.0.1:${fixturePort}`, "--port", String(proxyPort)], { stdio: "ignore" }));
  return `http://127.0.0.1:${proxyPort}`;
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const p90 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.9) - 1)];

async function once(browser, base) {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto(base + "/");
  await page.waitForFunction(() => window.currentStep === "DESKTOP", null, { timeout: 60_000 });
  const ms = await page.evaluate(() => performance.getEntriesByName("boot:desktop-ready")[0]?.startTime ?? null);
  await context.close();
  return ms;
}

const padded = mkdtempSync(join(tmpdir(), "boot-timing-")) + "/dist";
cpSync(join(ROOT, "dist"), padded, { recursive: true });
const hash = readdirSync(join(padded, "s"))[0];
const target = join(padded, "s", hash, "script.js");
const pad = `\n/*${randomBytes(EXTRA_KB * 1024).toString("base64")}*/\n`;
appendFileSync(target, pad);
console.log(`padding: +${(brotliCompressSync(Buffer.from(pad), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length / 1024).toFixed(1)} KB brotli in s/${hash}/script.js`);

const bases = { main: serve("dist", 4731, 4732), padded: serve(relative(ROOT, padded), 4733, 4734) };
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch();
try {
  const times = { main: [], padded: [] };
  await once(browser, bases.main); // warm the servers/JIT, discarded
  for (let i = 0; i < RUNS; i++) {
    for (const k of ["main", "padded"]) {
      try { times[k].push(await once(browser, bases[k])); } catch (e) { console.log(`${k}: run failed (${e.name}), skipped`); } // interleaved to cancel drift
    }
  }
  for (const k of ["main", "padded"]) {
    console.log(`${k}: runs=${times[k].map((t) => t.toFixed(0)).join(",")} median=${median(times[k]).toFixed(0)}ms p90=${p90(times[k]).toFixed(0)}ms`);
  }
  console.log(`delta median=${(median(times.padded) - median(times.main)).toFixed(0)}ms p90=${(p90(times.padded) - p90(times.main)).toFixed(0)}ms`);
} finally {
  await browser.close();
  for (const c of children) c.kill();
}
