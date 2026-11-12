import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEPLOY_VERIFIER_ROLE, type BrowserMethod } from "@fulcrumaxe/runner-protocol";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { verifyServerUp, type VerifyServerSpec } from "../../../src/engines/claude/settingsFile.js";
import { fixtureText, makeFake } from "./harness.js";
import { engineFor, makeRig } from "./rig.js";

/**
 * D#749: a playwright deploy verifier job whose `fxverify` server is not up at the CLI's init line ends at once with its own closed code, `verify_browser_unavailable`, instead of
 * letting the model answer with no browser (which is what a live run did: the init line said `{"name":"fxverify","status":"failed","source":"dynamic"}`, the model answered in one
 * turn, and the cloud saw only an answer it could not accept). The entry shape below is that live init line's entry, names only.
 */
const SERVER: VerifyServerSpec = { command: "/opt/fx/fx-runner", args: [], baseUrl: "https://app.example.test/", executable: "/opt/chrome/chromium", storageState: "/h/.config/fx-runner/verify/storage-state.json" };
const LIVE_FAILED = [{ name: "fxverify", status: "failed", source: "dynamic" }];

/** The captured subscription stream with its init line's `mcp_servers` replaced. */
const streamWithServers = (servers: unknown[]): string => fixtureText("stream.subscription.jsonl").replace('"mcp_servers":[]', `"mcp_servers":${JSON.stringify(servers)}`);

async function run(servers: unknown[], method: BrowserMethod = "playwright_runner", role = DEPLOY_VERIFIER_ROLE) {
  const rig = makeRig({ fake: makeFake({ stream: streamWithServers(servers) }) });
  rig.config.verifyServer = () => SERVER;
  const opts = { ...rig.startOptions({ role }), browserMethod: method };
  const outcome = await outcomeOf((await engineFor(rig).start(opts as never)).handle);
  return { outcome, events: opts.events, rig };
}

describe("verifyServerUp reads the init line's server list", () => {
  it("connected and pending are up; failed, needs-auth, another name, no entry and no list are down", () => {
    expect(verifyServerUp({ mcp_servers: [{ name: "fxverify", status: "connected" }] })).toBe(true);
    expect(verifyServerUp({ mcp_servers: [{ name: "fxverify", status: "pending" }] })).toBe(true);
    for (const servers of [LIVE_FAILED, [{ name: "fxverify", status: "needs-auth" }], [{ name: "other", status: "connected" }], [], [null, "fxverify"]]) expect(verifyServerUp({ mcp_servers: servers }), JSON.stringify(servers)).toBe(false);
    expect(verifyServerUp({})).toBe(false);
    expect(verifyServerUp({ mcp_servers: { fxverify: "connected" } })).toBe(false);
  });
});

describe("the engine ends a playwright job whose browser server is down", () => {
  it("the live init line (fxverify failed): failed verify_browser_unavailable, and no event after the init line reaches the run", async () => {
    const { outcome, events } = await run(LIVE_FAILED);
    expect(outcome).toMatchObject({ status: "failed", failureReason: "verify_browser_unavailable" });
    expect(outcome.agentOutput).toBeUndefined();
    // Only the init line was handed on; the model's answer that followed it never was.
    expect(events.length).toBeLessThanOrEqual(1);
  });

  it("no fxverify entry at all ends the same way", async () => {
    expect((await run([])).outcome).toMatchObject({ status: "failed", failureReason: "verify_browser_unavailable" });
  });

  it("a connected server goes on to the model's result as before", async () => {
    const { outcome, events } = await run([{ name: "fxverify", status: "connected" }]);
    expect(outcome.status).toBe("ok");
    expect(events.length).toBeGreaterThan(1);
  });

  it("a Chrome job and every other role are not judged by the server list", async () => {
    expect((await run([], "chrome_runner")).outcome.status).toBe("ok");
    const exec = makeRig();
    const outcome = await outcomeOf((await engineFor(exec).start(exec.startOptions())).handle);
    expect(outcome.status).toBe("ok");
    expect(existsSync(path.join(exec.config.jobsDir))).toBe(true);
  });
});
