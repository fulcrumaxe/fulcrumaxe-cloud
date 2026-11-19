import { afterEach, describe, expect, it } from "vitest";
import { AgentError, agentAtVsockDir, createGuestAgent, viaFirecrackerVsock } from "../../../src/vm/sandboxd/guestAgent.js";
import { makeRig, realOps, runCleanups, startSilentProxy } from "./helpers.js";

afterEach(runCleanups);
const params = (name: string) => ({ name, template: "fx-agent", vcpus: 2, memMb: 512 });
const timed = async (p: Promise<unknown>): Promise<{ err: unknown; ms: number }> => {
  const t = Date.now();
  const err = await p.then(() => undefined, (e: unknown) => e);
  return { err, ms: Date.now() - t };
};

describe("a guest that never answers the vsock CONNECT", () => {
  it("ping and exec time out instead of hanging, on the handshake's own deadline", async () => {
    const proxy = startSilentProxy();
    const agent = createGuestAgent(viaFirecrackerVsock(proxy, 5252, 150), 5000);
    for (const run of [() => agent.ping(), () => agent.runInGuest({ argv: ["true"] })]) {
      const { err, ms } = await timed(run());
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe("timeout");
      expect(ms).toBeLessThan(2000);
    }
  });

  it("a Connect with no deadline of its own is still bounded by the request", async () => {
    const agent = createGuestAgent(() => new Promise(() => undefined), 150);
    expect(((await timed(agent.ping())).err as AgentError).code).toBe("timeout");
    expect(((await timed(agent.runInGuest({ argv: ["true"] }))).err as AgentError).code).toBe("timeout");
  });

  it("create answers agent_not_ready at the boot bound even though each ping hangs", async () => {
    const proxy = startSilentProxy();
    const rig = makeRig({ agentFor: () => createGuestAgent(viaFirecrackerVsock(proxy, 5252, 60_000), 60_000), extra: { bootTimeoutMs: 300 } });
    const { err, ms } = await timed(rig.daemon.create(params("a")));
    expect(err).toMatchObject({ status: 502, code: "agent_not_ready" });
    expect(ms).toBeLessThan(3000);
    expect(rig.helper.frames.map((f) => f["verb"])).toEqual(["prepare", "start", "destroy"]);
    expect(rig.daemon.list()).toEqual([]);
  });

  it("delete is not held by a command whose start is stuck on a silent guest", async () => {
    const proxy = startSilentProxy();
    const silent = createGuestAgent(viaFirecrackerVsock(proxy, 5252, 60_000), 60_000);
    let swapped = false;
    const rig = makeRig({ agentFor: (dir) => (swapped ? silent : agentAtVsockDir(dir, realOps())), extra: { startWaitMs: 300 } });
    const sb = await rig.daemon.create(params("a"));
    swapped = true;
    (rig.daemon as unknown as { records: Map<string, { agent: unknown }> }).records.get("a")!.agent = silent;
    const stuck = sb.runCommand({ cmd: "sleep", args: ["31.9"] });
    stuck.catch(() => undefined);
    const { ms } = await timed(sb.delete());
    expect(ms).toBeLessThan(3000);
    expect(rig.daemon.list()).toEqual([]);
    expect(rig.helper.frames.map((f) => f["verb"])).toEqual(["prepare", "start", "destroy"]);
  });
});
