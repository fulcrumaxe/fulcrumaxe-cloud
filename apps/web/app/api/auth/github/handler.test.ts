import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AuthProvider } from "@fx/core/src/auth/provider";
import { OAUTH_STATE_COOKIE, githubSignInHandler } from "./handler";

describe("GET /api/auth/github", () => {
  it("redirects to the provider's authorization URL and sets a CSRF state cookie", async () => {
    const provider: AuthProvider = {
      name: "fake",
      getAuthorizationUrl: vi.fn(() => "https://github.example/authorize?state=abc"),
      exchangeCode: vi.fn(),
    };
    const req = new NextRequest("https://example.test/api/auth/github");

    const res = await githubSignInHandler(req, provider);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://github.example/authorize?state=abc");
    const stateCookie = res.cookies.get(OAUTH_STATE_COOKIE);
    expect(stateCookie).toBeDefined();
    expect(stateCookie?.httpOnly).toBe(true);
    expect(stateCookie?.secure).toBe(true);
  });

  describe("canonical origin", () => {
    const provider = (): AuthProvider => ({
      name: "fake",
      getAuthorizationUrl: vi.fn(() => "https://github.example/authorize?state=abc"),
      exchangeCode: vi.fn(),
    });
    afterEach(() => vi.unstubAllEnvs());

    it("redirects another host to the canonical origin with the same path and query, and sets no cookie", async () => {
      vi.stubEnv("FX_APP_ORIGIN", "https://canon.example");
      const p = provider();
      const res = await githubSignInHandler(new NextRequest("https://alias.example/api/auth/github?next=%2Fa%3Fb%3D1"), p);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("https://canon.example/api/auth/github?next=%2Fa%3Fb%3D1");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(p.getAuthorizationUrl).not.toHaveBeenCalled();
    });

    it("proceeds as today on the canonical host", async () => {
      vi.stubEnv("FX_APP_ORIGIN", "https://canon.example");
      const res = await githubSignInHandler(new NextRequest("https://canon.example/api/auth/github"), provider());
      expect(res.headers.get("location")).toBe("https://github.example/authorize?state=abc");
      expect(res.cookies.get(OAUTH_STATE_COOKIE)).toBeDefined();
    });

    it("is unchanged when the canonical origin is unset", async () => {
      vi.stubEnv("FX_APP_ORIGIN", "");
      const res = await githubSignInHandler(new NextRequest("https://alias.example/api/auth/github"), provider());
      expect(res.headers.get("location")).toBe("https://github.example/authorize?state=abc");
      expect(res.cookies.get(OAUTH_STATE_COOKIE)).toBeDefined();
    });

    it("never lets Host or X-Forwarded-Host choose the redirect target", async () => {
      vi.stubEnv("FX_APP_ORIGIN", "https://canon.example");
      const req = new NextRequest("https://alias.example/api/auth/github", {
        headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
      });
      const res = await githubSignInHandler(req, provider());
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("https://canon.example/api/auth/github");
      expect(res.headers.get("set-cookie")).toBeNull();
    });
  });
});
