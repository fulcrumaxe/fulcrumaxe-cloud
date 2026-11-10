#!/usr/bin/env node
// The command line of scripts/sidecar.mjs (D#749 V2c-2c), kept in a file of its own because the library file is bundled into the single executable.
//
//   node scripts/sidecar-cli.mjs build   --out-dir <dir>              lays <dir>/fx-runner-playwright down from the installed pinned package
//   node scripts/sidecar-cli.mjs install --binary-dir <dir> [--digest <hex>]  (re)lays it next to a binary that was built or installed another way; atomic, with rollback
//   node scripts/sidecar-cli.mjs verify  --binary-dir <dir> [--digest <hex>]
//                                                                     the folder is a whole, plain tree (and has this digest, when given)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SIDECAR_DIR, SidecarError, buildSidecar, installBeside, verifySidecar } from "./sidecar.mjs";

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (command === "build") {
      const out = flagValue(rest, "--out-dir");
      if (out === undefined) throw new SidecarError("usage", "build needs --out-dir <dir>");
      const built = buildSidecar({ dest: path.join(path.resolve(out), SIDECAR_DIR) });
      process.stdout.write(`${path.join(path.resolve(out), SIDECAR_DIR)}\nversion ${built.version}\ndigest ${built.digest}\nfiles ${built.entries.length}\n`);
    } else if (command === "install") {
      const dir = flagValue(rest, "--binary-dir");
      if (dir === undefined) throw new SidecarError("usage", "install needs --binary-dir <dir>");
      const digest = flagValue(rest, "--digest");
      // With --digest (the one the binary was built with, from its release manifest) a library that differs fails the install loudly and nothing is swapped in; without it the digest printed below is what to compare.
      if (digest !== undefined && !/^[0-9a-f]{64}$/.test(digest)) throw new SidecarError("usage", "--digest must be 64 hex digits");
      const built = installBeside({ binaryDir: path.resolve(dir), expectedDigest: digest });
      if (!verifySidecar(path.join(path.resolve(dir), SIDECAR_DIR), digest)) throw new SidecarError("verify_failed", "the sidecar folder that was just laid down does not verify");
      process.stdout.write(`${path.join(path.resolve(dir), SIDECAR_DIR)}\nversion ${built.version}\ndigest ${built.digest}\n`);
    } else if (command === "verify") {
      const dir = flagValue(rest, "--binary-dir");
      if (dir === undefined) throw new SidecarError("usage", "verify needs --binary-dir <dir>");
      if (!verifySidecar(path.join(path.resolve(dir), SIDECAR_DIR), flagValue(rest, "--digest"))) throw new SidecarError("verify_failed", "the sidecar folder is missing, not a plain tree, or does not have that digest");
      process.stdout.write("sidecar ok\n");
    } else throw new SidecarError("usage", "usage: sidecar.mjs <build --out-dir <dir> | install --binary-dir <dir> | verify --binary-dir <dir> [--digest <hex>]>");
    return 0;
  } catch (error) {
    process.stderr.write(`sidecar: ${error instanceof Error ? error.message : "failed"}\n`);
    return error instanceof SidecarError && error.code === "usage" ? 2 : 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
