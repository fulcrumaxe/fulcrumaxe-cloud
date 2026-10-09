import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { NODE_PINS, NODE_VERSION, hostPlatform } from "../../scripts/build-sea.mjs";
import { generateSelfSignedCert } from "../helpers/selfSignedCert.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "..", "scripts", "build-sea.mjs");
const SHASUMS = readFileSync(path.join(HERE, "..", "fixtures", `node-v${NODE_VERSION}-SHASUMS256.txt`), "utf8");

const platform = hostPlatform();
const pin = (NODE_PINS as Record<string, { archive: string; sha256: string }>)[platform];

interface Mirror {
  server: Server;
  url: string;
  caFile: string;
  dir: string;
}
const open: Mirror[] = [];
afterEach(() => {
  for (const mirror of open.splice(0)) {
    mirror.server.close();
    rmSync(mirror.dir, { recursive: true, force: true });
  }
});

/** A local TLS server standing in for nodejs.org: it serves `archive` under the pinned file name, and a SHASUMS256.txt built by `shasums`. */
async function mirror(archive: Buffer, shasums: (listed: string) => string): Promise<Mirror> {
  const { certPem, keyPem } = generateSelfSignedCert("127.0.0.1", 1, { ipAddresses: ["127.0.0.1"] });
  const dir = mkdtempSync(path.join(tmpdir(), "fx-sea-tamper-"));
  const caFile = path.join(dir, "ca.pem");
  writeFileSync(caFile, certPem);
  const server = createServer({ cert: certPem, key: keyPem }, (req, res) => {
    if (req.url === "/dist/SHASUMS256.txt") res.end(shasums(SHASUMS));
    else if (req.url === `/dist/${pin!.archive}`) res.end(archive);
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const made = { server, url: `https://127.0.0.1:${(server.address() as AddressInfo).port}/dist`, caFile, dir };
  open.push(made);
  return made;
}

function build(m: Mirror, outDir: string): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, "--out-dir", outDir],
      { env: { PATH: process.env.PATH ?? "", NODE_EXTRA_CA_CERTS: m.caFile, FX_SEA_NODE_DIST_URL: m.url, SOURCE_DATE_EPOCH: "1780000000", FX_FORBID_MODEL_CALLS: "1" } },
      (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr }),
    );
  });
}

const relist = (name: string, hex: string) => (text: string) =>
  text
    .split("\n")
    .map((line) => (line.endsWith(`  ${name}`) ? `${hex}  ${name}` : line))
    .join("\n");

describe.skipIf(pin === undefined)("a tampered Node download (R6-1 acceptance 4)", () => {
  it("exits non-zero and writes nothing when SHASUMS256.txt matches the download but the pinned hash does not", async () => {
    const tampered = Buffer.from("this is not the Node release");
    // The mirror also rewrites SHASUMS256.txt, so the listing agrees with the bytes: only the pin in build-sea.mjs can catch this.
    const m = await mirror(tampered, relist(pin!.archive, createHash("sha256").update(tampered).digest("hex")));
    const outDir = path.join(m.dir, "out");
    const result = await build(m, outDir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("pin_mismatch");
    expect(existsSync(outDir)).toBe(false);
  });

  it("also refuses a download that does not match SHASUMS256.txt, with its own reason", async () => {
    const m = await mirror(Buffer.from("something else"), (text) => text);
    const outDir = path.join(m.dir, "out");
    const result = await build(m, outDir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("shasums_mismatch");
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses a mirror whose SHASUMS256.txt does not name the archive", async () => {
    const m = await mirror(Buffer.from("x"), (text) => text.split("\n").filter((line) => !line.endsWith(pin!.archive)).join("\n"));
    const outDir = path.join(m.dir, "out");
    const result = await build(m, outDir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("shasums_missing_entry");
    expect(existsSync(outDir)).toBe(false);
  });
});
