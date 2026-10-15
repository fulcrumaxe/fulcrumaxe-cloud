// apps/web/test/middleware-host.test.ts
//
// D#4 P02a criterion 4, tested against the real middleware: the hostBrand step gives downstream code one trustworthy copy of the
// host (x-fx-host), taken from the Host header alone. Next carries the request headers a middleware sets to the route as
// `x-middleware-request-<name>` response headers, which is what is read here.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { HOST_HEADER } from "@fx/partners/host";
import { middleware } from "../middleware";

const FORWARDED = `x-middleware-request-${HOST_HEADER}`;

function get(headers: Record<string, string>): NextRequest {
  return new NextRequest("https://ignored.example/api/branding/partner", { headers });
}

describe("middleware: hostBrand step", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.FX_PARTNER_LAYER;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FX_PARTNER_LAYER;
    else process.env.FX_PARTNER_LAYER = saved;
  });

  it("with the layer on, hands downstream the normalised Host, not a client-sent x-fx-host and not X-Forwarded-Host", async () => {
    process.env.FX_PARTNER_LAYER = "on";
    const res = await middleware(
      get({ host: "Build.Acme.example.:443", "x-fx-host": "victim.example", "x-forwarded-host": "victim.example", forwarded: "host=victim.example" }),
    );
    expect(res.headers.get(FORWARDED)).toBe("build.acme.example");
  });

  it("with the layer off or unset, hands downstream no host header, and drops a client-sent one", async () => {
    for (const value of [undefined, "off", "ON"]) {
      if (value === undefined) delete process.env.FX_PARTNER_LAYER;
      else process.env.FX_PARTNER_LAYER = value;
      const res = await middleware(get({ host: "build.acme.example", "x-fx-host": "victim.example" }));
      expect(res.headers.get(FORWARDED), String(value)).toBeNull();
    }
  });
});
