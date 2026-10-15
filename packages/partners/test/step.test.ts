import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOST_HEADER, hostBrandStep } from "../src/host/index.js";

function run(requestHeaders: Record<string, string>, env: Record<string, string | undefined>, carried: Record<string, string> = {}) {
  const req = { headers: new Headers(requestHeaders) };
  const headers = new Headers({ ...requestHeaders, ...carried });
  hostBrandStep(req, headers, env);
  return headers;
}

describe("hostBrandStep", () => {
  it("sets the normalised Host and nothing else when the layer is on", () => {
    const headers = run({ host: "Build.Acme.example.:443" }, { FX_PARTNER_LAYER: "on" });
    expect(headers.get(HOST_HEADER)).toBe("build.acme.example");
  });

  it("ignores X-Forwarded-Host and Forwarded, which a client can send", () => {
    const headers = run(
      { host: "build.acme.example", "x-forwarded-host": "victim.example", forwarded: "host=victim.example" },
      { FX_PARTNER_LAYER: "on" },
    );
    expect(headers.get(HOST_HEADER)).toBe("build.acme.example");
    // They are left alone (Next's own checks read them); the step just never believes them.
    expect(headers.get("x-forwarded-host")).toBe("victim.example");
  });

  it("drops a client-sent x-fx-host, whether or not the layer is on", () => {
    expect(run({ host: "a.example.com" }, { FX_PARTNER_LAYER: "on" }, { [HOST_HEADER]: "victim.example" }).get(HOST_HEADER)).toBe("a.example.com");
    expect(run({ host: "a.example.com" }, { FX_PARTNER_LAYER: "off" }, { [HOST_HEADER]: "victim.example" }).has(HOST_HEADER)).toBe(false);
    expect(run({ host: "a.example.com" }, {}, { [HOST_HEADER]: "victim.example" }).has(HOST_HEADER)).toBe(false);
  });

  it("sets nothing for a Host that is not a hostname", () => {
    expect(run({ host: "[::1]:3000" }, { FX_PARTNER_LAYER: "on" }).has(HOST_HEADER)).toBe(false);
    expect(run({}, { FX_PARTNER_LAYER: "on" }).has(HOST_HEADER)).toBe(false);
  });
});

describe("host/ is safe for the Edge runtime", () => {
  it("imports nothing from node: or pg at runtime", () => {
    const dir = new URL("../src/host/", import.meta.url);
    for (const file of readdirSync(dir)) {
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source, file).not.toMatch(/from\s+["']node:/);
      expect(source, file).not.toMatch(/import\s+(?!type)[^;]*from\s+["']pg["']/);
      expect(source, file).not.toMatch(/\bprocess\.(?!env)/);
    }
  });
});
