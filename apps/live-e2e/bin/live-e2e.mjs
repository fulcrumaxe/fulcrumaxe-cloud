#!/usr/bin/env node
// Thin launcher: loads the TypeScript sources through tsx, then hands argv to the CLI.
import { register } from "tsx/esm/api";

register();
const { runFromProcess } = await import("../src/main.ts");
process.exitCode = await runFromProcess(process.argv.slice(2));
