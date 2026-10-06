import { describe, expect, it } from "vitest";
import { canonicalize, parse } from "@fx/env-spec";
import { ReplayError, createRunSandbox, replay, type ReplayPorts, type RunEnvironmentRecord } from "../src/index.js";
import { NET, digest, fakeSandbox } from "./fakes.js";

const WITH_NET = "version: 1\npreset: node\nnetwork:\n  domains: [registry.npmjs.org]\n";

/** A past run's record: the version and digest on the run, and the canonical spec stored with that version. */
function record(yaml = WITH_NET): RunEnvironmentRecord {
  const parsed = parse(yaml);
  if (!parsed.ok) throw new Error("fixture does not parse");
  return { envVersionId: "1".repeat(64), imageDigest: digest("9"), canonicalSpec: canonicalize(parsed.spec) };
}

describe("criterion 6: replay re-creates the sandbox from the recorded digest", () => {
  it("creates the sandbox from the digest on the run, with the egress of the spec stored with that version", async () => {
    const sb = fakeSandbox();
    const ports: ReplayPorts = { getRunEnvironment: async () => record(), networkContext: () => NET, sandbox: sb.port };
    const out = await replay(ports, "run-1");
    expect(out).toMatchObject({ envVersionId: "1".repeat(64), imageDigest: digest("9") });
    expect(sb.created.length).toBe(1);
    expect(sb.created[0]!.imageDigest).toBe(digest("9"));
    expect(sb.created[0]!.network.rules.map((r) => r.host)).toContain("registry.npmjs.org");
  });

  it("the replay ports have no way to read a file or a proposal", () => {
    const keys: (keyof ReplayPorts)[] = ["getRunEnvironment", "networkContext", "sandbox"];
    const ports: ReplayPorts = { getRunEnvironment: async () => null, networkContext: () => NET, sandbox: fakeSandbox().port };
    expect(Object.keys(ports).sort()).toEqual([...keys].sort());
    expect(Object.keys(ports).join()).not.toMatch(/read|file|proposal/i);
  });

  it("a run with no recorded environment cannot be replayed, and says why", async () => {
    const sb = fakeSandbox();
    const ports: ReplayPorts = { getRunEnvironment: async () => null, networkContext: () => NET, sandbox: sb.port };
    await expect(replay(ports, "old-run")).rejects.toMatchObject({ code: "no_environment_recorded" });
    await expect(replay(ports, "old-run")).rejects.toBeInstanceOf(ReplayError);
    expect(sb.created).toEqual([]);
  });

  it("a digest that is not sha256:<64 hex> is not replayed", async () => {
    const sb = fakeSandbox();
    const ports: ReplayPorts = { getRunEnvironment: async () => ({ ...record(), imageDigest: "latest" }), networkContext: () => NET, sandbox: sb.port };
    await expect(replay(ports, "r")).rejects.toMatchObject({ code: "no_environment_recorded" });
    expect(sb.created).toEqual([]);
  });

  it("a recorded spec that no longer parses is refused by name, with nothing created", async () => {
    const sb = fakeSandbox();
    const ports: ReplayPorts = { getRunEnvironment: async () => ({ ...record(), canonicalSpec: "{" }), networkContext: () => NET, sandbox: sb.port };
    await expect(replay(ports, "r")).rejects.toMatchObject({ code: "recorded_spec_unreadable" });
    expect(sb.created).toEqual([]);
  });

  it("the stored canonical spec round-trips through the parser", () => {
    const r = record();
    const parsed = parse(r.canonicalSpec);
    expect(parsed.ok && canonicalize(parsed.spec)).toBe(r.canonicalSpec);
  });
});

describe("criterion 7: the run-phase sandbox is created non-persistent (C1)", () => {
  it("replay's create call carries persistent: false and the egress fragment, deny by default", async () => {
    const sb = fakeSandbox();
    await replay({ getRunEnvironment: async () => record(), networkContext: () => NET, sandbox: sb.port }, "r");
    expect(sb.created[0]).toMatchObject({ persistent: false });
    expect(sb.created[0]!.network).toMatchObject({ default: "deny", appliesAt: "creation" });
  });

  it("createRunSandbox cannot be asked for a persistent sandbox", async () => {
    const sb = fakeSandbox();
    const network = { default: "deny", appliesAt: "creation", rules: [] } as const;
    await createRunSandbox(sb.port, { imageDigest: digest("1"), network });
    expect(sb.created[0]!.persistent).toBe(false);
    // @ts-expect-error persistent is the literal false on the port's request type
    await sb.port.create({ imageDigest: digest("1"), persistent: true, network });
  });
});
