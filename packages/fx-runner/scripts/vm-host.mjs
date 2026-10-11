// The real machine behind `fx-runner vm build-image` (src/vm/buildImage.ts, `BuildHost`): starts crane, tar and mke2fs by name with an argument
// list, no shell. It lives here, not in src/, because src/ never starts a process (test/prompt.test.ts). bin/fx-runner.mjs hands it to the
// CLI as `vmHost`, and scripts/vm-main.mjs (the small bundle the image workflow runs) uses it too.
import { execFile } from "node:child_process";

/** @type {import("../src/vm/buildImage.js").BuildHost} */
export const vmBuildHost = {
  run: (file, args, env) =>
    new Promise((resolve) => {
      // PATH, and LD_LIBRARY_PATH for a machine (NixOS) where mke2fs finds libarchive, which it loads at run time, outside the system paths
      const loader = process.env.LD_LIBRARY_PATH === undefined ? {} : { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH };
      execFile(file, [...args], { env: { PATH: process.env.PATH ?? "", ...loader, ...env }, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, output: `${stdout}${stderr}` });
      });
    }),
};
