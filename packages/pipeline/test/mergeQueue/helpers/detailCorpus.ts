/**
 * D#519 MQ4-d-0: one corpus of paths and branch names for the conflict-stop detail, run through BOTH the code filters (detailFilters.test.ts) and the SQL
 * functions (detailChecks.pg.test.ts), so the two cannot drift. `ok` is what the table must accept; `bad` is what it must refuse.
 */
export const GOOD_PATHS = ["src/a.ts", "a", "dir/sub/file.name.ts", ".github/x.yml", "a b.ts", "é/ü.ts", "x\u200by.ts", "x\u202ey.ts", "a..b.ts", "~a/b.ts", "C/x.ts", "a".repeat(512), "日".repeat(341)];

export const BAD_PATHS = [
  "",
  "/abs/x.ts",
  "~",
  "~/x.ts",
  "C:/x.ts",
  "z:/x",
  "a//b",
  "a/",
  "./a",
  "a/./b",
  "../a",
  "a/../b",
  "a\\b",
  "a\u0000b",
  "a\nb",
  "a\tb",
  "a\u007fb",
  "a\u0080b",
  "a\u0085b",
  "a\u009fb",
  "a\u2028b",
  "a\u2029b",
  "a".repeat(513),
  // 300 emoji: 300 characters (within the 512 cap) and 1200 bytes (over the 1024 byte cap).
  "😀".repeat(300),
];

export const GOOD_REFS = ["main", "master", "release/1.x", "feature/ok-1.2_x", "a", "é", "x\u200by", "x\u202ey", "a.b", "r".repeat(255)];

export const BAD_REFS = [
  "",
  "-x",
  "a..b",
  "a b",
  "a\tb",
  "a\nb",
  "a\u0000b",
  "a\u007fb",
  "a\u0080b",
  "a\u0085b",
  "a\u009fb",
  "a\u2028b",
  "a\u2029b",
  "x~",
  "a^b",
  "a:b",
  "a?b",
  "a*b",
  "a[b",
  "a\\b",
  "r".repeat(256),
  "é".repeat(128),
];
