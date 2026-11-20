import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pinned, UnitParams } from "../../../src/vm/unitRender.js";

export const HARDENING_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../vmhelper/internal/hardening");
/** The cases the Go renderer writes golden files for; every renderer is tested against the same list. */
export const cases = JSON.parse(readFileSync(join(HARDENING_DIR, "testdata/unit-cases.json"), "utf8")) as { name: string; params: UnitParams }[];
export const pinnedFile = JSON.parse(readFileSync(join(HARDENING_DIR, "hardening.json"), "utf8")) as Pinned;
export const goldenUnit = (name: string): string => readFileSync(join(HARDENING_DIR, "testdata", `${name}.unit`), "utf8");
