// apps/workspace/test/brotli-proxy-tls.test.mjs
//
// perf/brotli-proxy.mjs --tls generates its key at start into a private
// temp directory and removes it on exit; no key lives in the repository.

import { describe, expect, it } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PERF = join(HERE, "..", "perf");
const REPO = join(HERE, "..", "..", "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function listing() {
  return fs.readdirSync(PERF).sort();
}

describe("brotli-proxy --tls", () => {
  it("serves HTTPS with a run-time key, then deletes it on exit", async () => {
    const before = listing();
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("fixture-body");
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const upPort = upstream.address().port;
    const port = await freePort();

    const child = spawn(
      "node",
      [join(PERF, "brotli-proxy.mjs"), "--upstream", `http://127.0.0.1:${upPort}`, "--port", String(port), "--tls"],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    const ready = new Promise((resolve, reject) => {
      child.stdout.on("data", (d) => {
        out += d;
        if (out.includes("listening")) resolve();
      });
      child.on("exit", () => reject(new Error("proxy exited early")));
    });
    try {
      await ready;
      const tlsDir = /tls dir (\S+)/.exec(out)?.[1];
      expect(tlsDir).toBeTruthy();
      expect(fs.statSync(join(tlsDir, "key.pem")).mode & 0o777).toBe(0o600);

      const body = await new Promise((resolve, reject) => {
        https
          .get({ host: "127.0.0.1", port, path: "/", rejectUnauthorized: false }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks).toString()));
          })
          .on("error", reject);
      });
      expect(body).toBe("fixture-body");
      expect(listing()).toEqual(before);

      const exited = new Promise((r) => child.on("exit", r));
      child.kill("SIGTERM");
      await exited;
      expect(fs.existsSync(tlsDir)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      upstream.close();
    }
    expect(listing()).toEqual(before);
  }, 30_000);

  it("keeps no private key outside archive/ in the repository", () => {
    const tracked = execFileSync("git", ["ls-files", "--", "*.pem", "*.key", "*.p12", "*.pfx"], {
      cwd: REPO,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.startsWith("archive/") && !/(^|\/)(test|tests|fixtures|__fixtures__)\//.test(f));
    expect(tracked).toEqual([]);
  });
});
