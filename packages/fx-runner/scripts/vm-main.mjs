// The small program the image workflow bundles with esbuild and runs, so it does not need the whole CLI (and its single-executable build):
//
//   esbuild scripts/vm-main.mjs --bundle --platform=node --format=esm --outfile=fx-vm.mjs
//   node fx-vm.mjs build-image --template fx-agent --image <repository@sha256:...> --out <dir>
//
// It is `fx-runner vm ...` without the rest of fx-runner: the same `vmCommand`, the same host (scripts/vm-host.mjs).
import { createRequire } from "node:module";
import path from "node:path";
import { CliError } from "../src/cliError.js";
import { vmCommand } from "../src/vm/command.js";
import { vmBuildHost } from "./vm-host.mjs";

// D#845 ON-13b1: the guest's engine supervisor is bundled here, from the runner's own sources, with the esbuild the step above just ran (found from the repository root, where the image is built:
// this file is itself bundled, so it cannot import esbuild). The disk is refused without it (`buildImage`).
const bundleSupervisor = async (entry) => {
  const { build } = createRequire(path.join(process.cwd(), "packages/fx-runner/package.json"))("esbuild");
  const built = await build({ entryPoints: [path.resolve(entry)], bundle: true, platform: "node", format: "esm", target: "node24", write: false, legalComments: "none", logLevel: "silent" });
  return built.outputFiles[0].text;
};

vmCommand(process.argv.slice(2), { ...vmBuildHost, bundleSupervisor }, (line) => process.stdout.write(`${line}\n`)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`fx-vm: ${error instanceof CliError ? error.message : "unexpected failure"}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  },
);
