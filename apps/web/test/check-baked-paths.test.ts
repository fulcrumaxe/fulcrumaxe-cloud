import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findBaked } from "../scripts/check-baked-paths.mjs";

/**
 * The matcher behind `node apps/web/scripts/check-baked-paths.mjs`, run on small fabricated build trees. The
 * real build is checked by scripts/check.sh; this pins what each allowlist entry may and may not let through.
 */
const ROOT = "/build/machine/repo";
const NEXT = `${ROOT}/node_modules/.pnpm/next@15.5.26_react@19.0.0/node_modules/next/dist/client/components/layout-router.js`;
const PROXY = (p: string) => `let{createProxy:d}=c(88226);a.exports=d("${p}")`;

let serverDir: string;

function put(rel: string, text: string): void {
  const full = path.join(serverDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

const find = (): string[] => (findBaked as (dir: string, roots: string[]) => string[])(serverDir, [ROOT]);

beforeEach(() => {
  serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "baked-paths-"));
});
afterEach(() => {
  fs.rmSync(serverDir, { recursive: true, force: true });
});

describe("check-baked-paths allowlist", () => {
  it("reports a baked file:// URL under apps/web/app (a route reading a sibling via import.meta.url)", () => {
    put("app/api/health/route.js", `const u="file://${ROOT}/apps/web/app/api/health/route.ts";`);
    expect(find()).toEqual(["app/api/health/route.js: file://<root>/apps/web/app/api/health/route.ts"]);
  });

  it("allows a plain route label under apps/web/app", () => {
    put("app/api/health/route.js", `const r={resolvedPagePath:"${ROOT}/apps/web/app/api/health/route.ts"};`);
    expect(find()).toEqual([]);
  });

  it("allows Next's own labels in a client-reference manifest and a createProxy chunk", () => {
    put("app/route_client-reference-manifest.js", `x["${ROOT}/apps/web/app/layout"]=1;y["${NEXT}"]=2;`);
    put("chunks/4024.js", `${PROXY(NEXT)}`);
    expect(find()).toEqual([]);
  });

  it("reports a file:// URL inside a Next chunk that is not on the allowlist", () => {
    put("chunks/4024.js", `const u="file://${NEXT}";`);
    expect(find()).toEqual([`chunks/4024.js: file://<root>${NEXT.slice(ROOT.length)}`]);
  });

  it("reports a file:// URL inside a manifest even for a Next or apps/web path", () => {
    put("app/route_client-reference-manifest.js", `a("file://${NEXT}");b("file://${ROOT}/apps/web/app/layout");`);
    expect(find()).toHaveLength(2);
  });

  it("reports a plain Next path in a chunk that is not a createProxy label", () => {
    put("chunks/4024.js", `fs.readFileSync("${NEXT}")`);
    expect(find()).toEqual([`chunks/4024.js: <root>${NEXT.slice(ROOT.length)}`]);
  });

  it("reports a Next path outside Next's dist directory", () => {
    put("chunks/4024.js", `${PROXY(`${ROOT}/node_modules/.pnpm/next@15.5.26_react@19.0.0/node_modules/other/data.json`)}`);
    expect(find()).toHaveLength(1);
  });

  describe("the three reviewed file:// uses", () => {
    const WORLD_LOCAL = `${ROOT}/node_modules/.pnpm/@workflow+world-local@4.4.1/node_modules/@workflow/world-local/dist/init.js`;
    const CBOR = `${ROOT}/node_modules/.pnpm/cbor-x@1.6.0/node_modules/cbor-x/node-index.js`;
    const ADOPTION = `${ROOT}/packages/webhooks/src/adoption.ts`;

    it("stay allowed in a numbered chunk", () => {
      put("chunks/1234.js", `a(0,ap.fileURLToPath)("file://${WORLD_LOCAL}");b(0,f0.createRequire)("file://${CBOR}");c=[0,"file://${ADOPTION}"];`);
      expect(find()).toEqual([]);
    });

    it.each([
      ["@workflow/world-local", WORLD_LOCAL],
      ["cbor-x", CBOR],
      ["webhooks adoption", ADOPTION],
    ])("%s is not allowed outside a numbered chunk", (_name, target) => {
      put("app/api/health/route.js", `x("file://${target}")`);
      expect(find()).toHaveLength(1);
    });

    it("do not extend to a sibling file in the same package", () => {
      put("chunks/1234.js", `a("file://${ROOT}/node_modules/.pnpm/cbor-x@1.6.0/node_modules/cbor-x/other.js");b("file://${ROOT}/packages/webhooks/src/other.ts")`);
      expect(find()).toHaveLength(2);
    });
  });
});
