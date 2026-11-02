import { describe, expect, it } from "vitest";
import { isDetailPath, isDetailRef } from "../../src/mergeQueue/conflict.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { BAD_PATHS, BAD_REFS, GOOD_PATHS, GOOD_REFS } from "./helpers/detailCorpus.js";

/** D#519 MQ4-d-0: the SQL side of the shared corpus, and every code point of the basic plane through both sides. */
describe("conflict-stop detail: the SQL checks and the code filters agree [pg]", () => {
  const db = pgHarness();
  const sqlPath = async (p: string) => (await db.admin.query(`SELECT driver_event_paths_ok(ARRAY[$1]::text[]) AS ok`, [p])).rows[0].ok as boolean;
  const sqlRef = async (r: string) => (await db.admin.query(`SELECT driver_event_ref_ok($1) AS ok`, [r])).rows[0].ok as boolean;

  it("the corpus: every good path and branch is taken and every bad one refused, by the SQL, and the code filters say the same", async () => {
    for (const p of GOOD_PATHS) {
      expect(await sqlPath(p), `sql ${JSON.stringify(p.slice(0, 20))}`).toBe(true);
      expect(isDetailPath(p)).toBe(true);
    }
    for (const p of BAD_PATHS.filter((x) => !x.includes("\u0000"))) {
      expect(await sqlPath(p), `sql ${JSON.stringify(p.slice(0, 20))}`).toBe(false);
      expect(isDetailPath(p)).toBe(false);
    }
    for (const r of GOOD_REFS) {
      expect(await sqlRef(r), `sql ${JSON.stringify(r.slice(0, 20))}`).toBe(true);
      expect(isDetailRef(r)).toBe(true);
    }
    for (const r of BAD_REFS.filter((x) => !x.includes("\u0000"))) {
      expect(await sqlRef(r), `sql ${JSON.stringify(r.slice(0, 20))}`).toBe(false);
      expect(isDetailRef(r)).toBe(false);
    }
  });

  it("a path of 1200 bytes (300 emoji) is refused by the SQL and filtered by the code", async () => {
    const p = "😀".repeat(300);
    expect(Buffer.byteLength(p)).toBe(1200);
    expect(await sqlPath(p)).toBe(false);
    expect(isDetailPath(p)).toBe(false);
  });

  it("no code point of the basic plane is accepted by the code filter and refused by the SQL (in a path, and in a branch)", async () => {
    const { rows } = await db.admin.query<{ cp: number; path_ok: boolean; ref_ok: boolean }>(
      `SELECT cp, driver_event_paths_ok(ARRAY['a' || chr(cp) || 'b']) AS path_ok, driver_event_ref_ok('a' || chr(cp) || 'b') AS ref_ok
         FROM generate_series(1, 65535) AS cp WHERE cp NOT BETWEEN 55296 AND 57343`,
    );
    expect(rows.length).toBeGreaterThan(63000);
    const loosePath: number[] = [];
    const looseRef: number[] = [];
    for (const r of rows) {
      const ch = String.fromCodePoint(r.cp);
      if (isDetailPath(`a${ch}b`) && !r.path_ok) loosePath.push(r.cp);
      if (isDetailRef(`a${ch}b`) && !r.ref_ok) looseRef.push(r.cp);
    }
    expect(loosePath).toEqual([]);
    expect(looseRef).toEqual([]);
  });
});
