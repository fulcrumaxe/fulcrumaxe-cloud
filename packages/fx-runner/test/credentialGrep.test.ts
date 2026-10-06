import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_DIR, srcFiles } from "./helpers/srcFiles.js";

/** Where a Claude login is stored or minted. The runner never looks there: it passes the user's own login through. */
const BANNED = [".credentials.json", "find-generic-password", "keytar", "setup-token", "/login", "CLAUDE_CODE_OAUTH_TOKEN"];

/** The one place a banned name may appear: the subscription token's pass-through in subscription mode. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = { "packages/fx-runner/src/job/cleanEnv.ts": ["CLAUDE_CODE_OAUTH_TOKEN"] };

export function credentialHits(files: ReadonlyArray<readonly [string, string]>): string[] {
  const hits: string[] = [];
  for (const [name, text] of files) {
    for (const term of BANNED) if (text.includes(term) && !(ALLOWED[name] ?? []).includes(term)) hits.push(`${name}: ${term}`);
  }
  return hits;
}

function protocolSources(): Array<[string, string]> {
  const dir = path.join(PACKAGE_DIR, "..", "runner-protocol", "src");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .map((file): [string, string] => [`packages/runner-protocol/src/${file}`, readFileSync(path.join(dir, file), "utf8")]);
}

describe("credential grep", () => {
  it("finds no banned name in fx-runner's or runner-protocol's source apart from the one allowed pass-through", () => {
    const own = srcFiles().map(([name, text]): [string, string] => [`packages/fx-runner/${name}`, text]);
    const all = [...own, ...protocolSources()];
    expect(all.length).toBeGreaterThan(10);
    expect(credentialHits(all)).toEqual([]);
    expect(own.find(([name]) => name.endsWith("cleanEnv.ts"))![1]).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("the scan does see each name, and the allowance covers only cleanEnv.ts", () => {
    expect(BANNED.length).toBe(6);
    for (const term of BANNED) expect(credentialHits([["packages/fx-runner/src/x.ts", `const a = "${term}";`]]), term).toHaveLength(1);
    expect(credentialHits([["packages/fx-runner/src/job/cleanEnv.ts", 'const a = "CLAUDE_CODE_OAUTH_TOKEN";']])).toEqual([]);
    expect(credentialHits([["packages/fx-runner/src/job/cleanEnv.ts", 'const a = "keytar";']])).toHaveLength(1);
  });
});
