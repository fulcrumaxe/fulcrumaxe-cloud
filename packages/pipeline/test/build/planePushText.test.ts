import { describe, expect, it } from "vitest";
import { buildPlanePushText } from "@fx/core/src/repos/planePushText.js";
import { readPlanePushIdentity } from "@fx/core/src/repos/planePushIdentity.js";
import { PlaneRouteError, routeAndPush, type PlaneRouteDeps, type PlaneRouteInput } from "../../src/build/planePushRoute.js";

/**
 * D#598 P1f-2b, Gate 2 on the real consumer: the text and identity the token route returns are fed to the real `routeAndPush` input check
 * (`validateInput`), the one the run-end hook runs. The route is stopped right after that check by a transport that refuses, so the only
 * question answered here is "did the input pass" (a `bad_input` would be the answer if not). No git is run and no network is touched.
 */

const RUN = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const stop = new Error("stopped after the input check");
const deps: PlaneRouteDeps = {
  loadPairing: async () => ({ enabled: true, codeRepo: "acme/widgets", overlayGlobs: ["docs/ops/"], identifierRulesPath: null, planDataRulesPath: null }),
  loadOwn: async () => ({ owner: "acme", name: "widgets-private" }),
  api: {} as PlaneRouteDeps["api"],
  transport: {
    fetchTip: async () => {
      throw stop;
    },
  } as unknown as PlaneRouteDeps["transport"],
};

const identity = (() => {
  const read = readPlanePushIdentity({ FX_PLANE_PUSH_IDENTITY_NAME: "Fulcrumaxe Bot", FX_PLANE_PUSH_IDENTITY_EMAIL: "bot@example.com" });
  if (!read.ok) throw new Error("fixture identity is invalid");
  return read.identity;
})();

const input = (over: Partial<PlaneRouteInput>): PlaneRouteInput => ({
  repoDir: "/nonexistent",
  privateBase: "a".repeat(40),
  privateHead: "b".repeat(40),
  own: { owner: "acme", name: "widgets-private" },
  defaultBranch: "main",
  branch: "fx/p-0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e",
  title: "t",
  body: "b",
  identity,
  commitTime: 1_760_000_000,
  ...over,
});

const outcome = async (over: Partial<PlaneRouteInput>): Promise<string> => {
  try {
    await routeAndPush(input(over), deps);
    return "completed";
  } catch (error) {
    // The refusing transport is reached only after the input check, and the route reports it as public_unavailable.
    if (error instanceof PlaneRouteError) return error.code === "public_unavailable" ? "passed_input_check" : error.code;
    return `other: ${(error as Error).message}`;
  }
};

describe("the text the token route builds passes the run-end route's own input check", () => {
  const titles = ["Add the export button", "", "   ", "x".repeat(10_000), "Fixes #12 @victim https://evil.example/x\nsecond line", "line\r\nbreak", "nul\u0000byte", "`rm -rf`", "\u{1F680}\u{1F680}", "#@12 #1#2", "a_https://evil.example/x", "1https://evil.example/x", "x_www.evil.example", "Fixes GH-12 and gh-34", "fix #\u200b12", "\u200b\u200b", "\u{E0041}\u{E0042}", "\u202esafe"];

  it.each(titles.map((t) => [JSON.stringify(t).slice(0, 40), t]))("%s", async (_label, title) => {
    const text = buildPlanePushText({ itemTitle: title, runId: RUN });
    expect(await outcome({ title: text.title, body: text.body })).toBe("passed_input_check");
  });

  it("control: the raw hostile titles are refused bad_input by the same check, so the passes above are not vacuous", async () => {
    for (const raw of ["two\nlines", "nul\u0000byte", "x".repeat(257), " padded ", ""]) expect(await outcome({ title: raw, body: "b" }), JSON.stringify(raw)).toBe("bad_input");
  });

  it("the identity from the settings passes, and a malformed one is refused bad_input (the settings reader and the route agree)", async () => {
    expect(await outcome({ title: "t", body: "b", identity })).toBe("passed_input_check");
    for (const bad of [{ name: "Bot <b>", email: "bot@example.com" }, { name: "Bot", email: "bot@" }, { name: "", email: "bot@example.com" }]) expect(await outcome({ identity: bad }), JSON.stringify(bad)).toBe("bad_input");
  });
});
