// The small program the image workflow bundles with esbuild and runs, so it does not need the whole CLI (and its single-executable build):
//
//   esbuild scripts/vm-main.mjs --bundle --platform=node --format=esm --outfile=fx-vm.mjs
//   node fx-vm.mjs build-image --template fx-agent --image <repository@sha256:...> --out <dir>
//
// It is `fx-runner vm ...` without the rest of fx-runner: the same `vmCommand`, the same host (scripts/vm-host.mjs).
import { CliError } from "../src/cliError.js";
import { vmCommand } from "../src/vm/command.js";
import { vmBuildHost } from "./vm-host.mjs";

vmCommand(process.argv.slice(2), vmBuildHost, (line) => process.stdout.write(`${line}\n`)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`fx-vm: ${error instanceof CliError ? error.message : "unexpected failure"}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  },
);
