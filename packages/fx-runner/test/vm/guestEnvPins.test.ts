import { describe, expect, it } from "vitest";
import { MICROVM_CONNECT_RELAY } from "@fx/runner";
import { SUBSCRIPTION_TOKEN_VAR } from "../../src/job/cleanEnv.js";
import { EGRESS_VSOCK_PORT } from "../../src/vm/egress/proxy.js";
import { MICROVM_ENV_NAMES, MICROVM_NETWORK_ENV, REVERSE_HOSTS, guestEnvOf, microvmEnvAllowed } from "../../src/vm/sandboxd/guestEnv.js";
import { createEgressPolicyPort, type EgressStarters } from "../../src/vm/sandboxd/policyPort.js";

/** D#587 B-5b-3b criteria 19, 21 and 22: no literal address pinned in a test, the OAuth name never in the guest table, and the runner's own uid reaching the listeners. */
describe("the relay address is derived, never pinned by a literal (criterion 21)", () => {
  const relays = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;

  it("all four proxy names carry one address, and it is the loopback relay of the egress vsock port", () => {
    const values = new Set(relays.map((name) => MICROVM_NETWORK_ENV[name]));
    expect(values.size).toBe(1);
    expect([...values][0]).toBe(`http://127.0.0.1:${EGRESS_VSOCK_PORT}`);
  });

  it("the hosted package's constant for the guest relay is the same address the runner's table pins (a change to one alone fails here)", () => {
    expect(MICROVM_NETWORK_ENV["HTTPS_PROXY"]).toBe(MICROVM_CONNECT_RELAY);
  });

  it("NO_PROXY and the model base URL are built from the one reverse-host list", () => {
    expect(MICROVM_NETWORK_ENV["NO_PROXY"]).toBe(["127.0.0.1", "localhost", ...REVERSE_HOSTS.filter((host) => host !== "github.com")].join(","));
    expect(MICROVM_NETWORK_ENV["no_proxy"]).toBe(MICROVM_NETWORK_ENV["NO_PROXY"]);
    expect(MICROVM_NETWORK_ENV["ANTHROPIC_BASE_URL"]).toBe(`http://${REVERSE_HOSTS[0]}`);
  });
});

describe("the guest env table never carries the credential (criterion 19)", () => {
  it("the subscription variable is not a name of the table, and a job that carries it is refused before anything is built", () => {
    expect(MICROVM_ENV_NAMES.has(SUBSCRIPTION_TOKEN_VAR)).toBe(false);
    expect(microvmEnvAllowed({ [SUBSCRIPTION_TOKEN_VAR]: "sentinel-token" })).toBe(false);
    expect(JSON.stringify(guestEnvOf({}))).not.toContain(SUBSCRIPTION_TOKEN_VAR);
  });
});

describe("the runner's own uid reaches the listeners (criterion 22)", () => {
  it("both starters get the uid the edge passed in, and the gid the helper reported", async () => {
    const seen: Array<{ which: string; uid: number; gid: number }> = [];
    const egress: EgressStarters = {
      startProxy: async (o) => (seen.push({ which: "proxy", uid: o.uid, gid: o.sandboxGid }), { close: async () => undefined }),
      startReverse: async (o) => (seen.push({ which: "reverse", uid: o.uid, gid: o.sandboxGid }), { close: async () => undefined }),
    };
    const port = createEgressPolicyPort({ helper: { list: async () => [{ sandboxId: "sb-1", sandboxGid: 777, vsockDir: "/run/fx/sb-1" } as never] }, uid: 4242, egress });
    await port.apply("sb-1", "deny-all");
    expect(seen).toEqual([{ which: "proxy", uid: 4242, gid: 777 }, { which: "reverse", uid: 4242, gid: 777 }]);
    await port.release("sb-1");
  });
});
