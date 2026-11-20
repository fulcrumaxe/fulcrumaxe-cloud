import { describe, expect, it } from "vitest";
import { MICROVM_CONNECT_RELAY, SANDBOX_CA_ENV, buildSandboxEnv, isForbiddenSandboxEnvName, microvmNetworkEnv, type GuestEngine } from "../src/sandboxEnv.js";
import { assertSandboxEnvMatchesRole } from "../src/fakeSandbox.js";
import { PLANE_PUBLISH_ROLE } from "../src/sandboxNaming.js";
import { createVercelSandboxPort, type VercelSandboxSdk } from "../src/vercelSandboxPort.js";
import type { NetworkPolicyRule } from "../src/networkPolicy.js";
import type { Role } from "../src/types.js";

/** D#587 B-5, ruling 5: one env table per engine, and the microVM one trusts no CA. */
const MODEL: NetworkPolicyRule[] = [{ host: "api.anthropic.com", purpose: "model", authHeader: "x-api-key" }];
const GATEWAY: NetworkPolicyRule[] = [{ host: "ai-gateway.vercel.sh", purpose: "model", authHeader: "authorization" }];
const PROXY: NetworkPolicyRule[] = [{ host: "gh-proxy.example", purpose: "github_proxy" }];
const CA_NAMES = Object.keys(SANDBOX_CA_ENV);
const microvm = (rules: NetworkPolicyRule[]): GuestEngine => ({ kind: "microvm", rules });
const ROLES: Role[] = ["executor", "code-reviewer", PLANE_PUBLISH_ROLE as Role];

describe("the microVM guest env table", () => {
  it("pins the guest CONNECT relay address the guest image must listen on", () => {
    expect(MICROVM_CONNECT_RELAY).toBe("http://127.0.0.1:5253");
  });

  it("has no CA variable, for every role and both modes", () => {
    for (const role of ROLES) {
      for (const mode of ["tenant_key", "operator_subscription"] as const) {
        if (role === PLANE_PUBLISH_ROLE && mode === "operator_subscription") continue;
        const env = buildSandboxEnv(role, mode, microvm([...MODEL, ...PROXY]));
        for (const name of CA_NAMES) expect(env, `${role}/${mode}/${name}`).not.toHaveProperty(name);
        expect(Object.keys(env).filter((n) => /CA_BUNDLE|CAINFO|CA_CERTS|SSL_CERT/i.test(n))).toEqual([]);
        for (const name of Object.keys(env)) expect(isForbiddenSandboxEnvName(name, mode), name).toBe(false);
      }
    }
  });

  it("points the proxy variables at the guest's CONNECT relay and the model base URL at the plain-HTTP host the relay serves", () => {
    expect(microvmNetworkEnv([...MODEL, ...PROXY])).toEqual({
      HTTPS_PROXY: MICROVM_CONNECT_RELAY,
      HTTP_PROXY: MICROVM_CONNECT_RELAY,
      NO_PROXY: "127.0.0.1,localhost,api.anthropic.com,api.github.com,github.com",
      ANTHROPIC_BASE_URL: "http://api.anthropic.com",
    });
    expect(microvmNetworkEnv(GATEWAY)["ANTHROPIC_BASE_URL"]).toBe("http://ai-gateway.vercel.sh");
    expect(microvmNetworkEnv(GATEWAY)["NO_PROXY"]).toBe("127.0.0.1,localhost,ai-gateway.vercel.sh");
  });

  it("a publish sandbox (no model) gets the proxy variables and no base URL; its GitHub hosts bypass the CONNECT relay", () => {
    const env = buildSandboxEnv(PLANE_PUBLISH_ROLE as Role, "tenant_key", microvm(PROXY));
    expect(env).toEqual({ HTTPS_PROXY: MICROVM_CONNECT_RELAY, HTTP_PROXY: MICROVM_CONNECT_RELAY, NO_PROXY: "127.0.0.1,localhost,api.github.com,github.com" });
  });

  it("keeps the role's own variables: the placeholders and the context levers are the same in both tables", () => {
    const hosted = buildSandboxEnv("executor");
    const vm = buildSandboxEnv("executor", "tenant_key", microvm(MODEL));
    for (const name of CA_NAMES) delete hosted[name];
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ANTHROPIC_BASE_URL"]) delete vm[name];
    expect(vm).toEqual(hosted);
  });

  it("the hosted table is unchanged: the four CA variables, and no proxy variable", () => {
    for (const role of ROLES) {
      const env = buildSandboxEnv(role);
      for (const name of CA_NAMES) expect(env[name]).toBe(SANDBOX_CA_ENV[name]);
      expect(env).not.toHaveProperty("HTTPS_PROXY");
      expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    }
  });
});

describe("the port checks the table of the engine it was built for", () => {
  const sdk: VercelSandboxSdk = { create: async () => Promise.reject(new Error("stop")), get: async () => Promise.reject(new Error("stop")) };
  const portFor = (guestEngine?: "microvm") => createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk, image: `fx-agent@sha256:${"d".repeat(64)}`, ...(guestEngine === undefined ? {} : { guestEngine }) });
  const run = (env: Record<string, string>) => ({ role: PLANE_PUBLISH_ROLE as Role, cmd: "node", args: ["x.js"], env, networkPolicy: PROXY, timeoutMs: 30_000 });
  const handle = { runId: "", sandboxName: "pp-11111111-2222-4333-8444-555555555555" };

  it("a microVM port refuses the hosted env, and accepts its own (the next failure is the SDK's)", async () => {
    const port = portFor("microvm");
    await expect(port.runCommand(handle, run(buildSandboxEnv(PLANE_PUBLISH_ROLE as Role)))).rejects.toThrow(/env must equal/);
    await expect(port.runCommand(handle, run(buildSandboxEnv(PLANE_PUBLISH_ROLE as Role, "tenant_key", microvm(PROXY))))).rejects.toThrow(/runCommand failed/);
  });

  it("a hosted port refuses the microVM env, and accepts its own", async () => {
    const port = portFor();
    await expect(port.runCommand(handle, run(buildSandboxEnv(PLANE_PUBLISH_ROLE as Role, "tenant_key", microvm(PROXY))))).rejects.toThrow(/env must equal/);
    await expect(port.runCommand(handle, run(buildSandboxEnv(PLANE_PUBLISH_ROLE as Role)))).rejects.toThrow(/runCommand failed/);
  });

  it("the check reads the rules of the command itself: an env built for other rules is refused", () => {
    expect(() => assertSandboxEnvMatchesRole("executor", buildSandboxEnv("executor", "tenant_key", microvm(MODEL)), microvm(GATEWAY))).toThrow(/env must equal/);
    expect(() => assertSandboxEnvMatchesRole("executor", buildSandboxEnv("executor", "tenant_key", microvm(MODEL)), microvm(MODEL))).not.toThrow();
  });
});
