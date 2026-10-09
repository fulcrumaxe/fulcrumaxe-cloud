#!/usr/bin/env node
// Make an Ed25519 signing key for the release metadata (D#6 R6-3). The private half is written, mode 0600, to the path named by --out,
// which must be outside every git working tree and must not exist. Only the PUBLIC key is printed (a JWK); nothing secret reaches
// standard output or standard error.
//
//   node scripts/tuf-keygen.mjs --out <path outside the repo>
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReleaseToolError, writeNewKey } from "./tuf-lib.mjs";

/**
 * @param {string[]} argv
 * @param {{ out: (s: string) => unknown, err: (s: string) => unknown }} [io]
 */
export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  if (argv.length !== 2 || argv[0] !== "--out" || argv[1] === undefined || argv[1].startsWith("-")) {
    io.err("usage: tuf-keygen.mjs --out <private key path, outside the repository>\n");
    return 2;
  }
  try {
    const jwk = writeNewKey(argv[1]);
    io.out(`${JSON.stringify(jwk)}\n`);
    return 0;
  } catch (error) {
    io.err(`tuf-keygen: ${error instanceof ReleaseToolError ? error.message : "failed"}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
