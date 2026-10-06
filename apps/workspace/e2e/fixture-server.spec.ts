// apps/workspace/e2e/fixture-server.spec.ts
//
// e2e/fixture-server.mjs keeps idle kept-alive sockets open for longer than any test runs. With Node's default
// (5 s) the server is the side that closes an idle pooled socket, and a pass-through (route.fetch) that reuses it at
// that instant fails with "socket hang up". That race was never reproduced, so this pins the setting and the header
// clients see, so it cannot silently go back to the default.

import { test, expect } from "@playwright/test";
import { startFixtureServer } from "./fixture-server.mjs";

const LONGEST_TEST_TIMEOUT_MS = 180_000; // idle-network.spec.ts

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent");
});

test("the fixture server keeps idle sockets open past the longest test, and tells clients so", async () => {
  const { server, url, stop } = await startFixtureServer({ port: 0, features: {} });
  try {
    expect(server.keepAliveTimeout).toBeGreaterThan(LONGEST_TEST_TIMEOUT_MS);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);

    const res = await fetch(`${url}/api/mode`);
    const hint = /timeout=(\d+)/.exec(res.headers.get("keep-alive") ?? "");
    expect(hint, "the response carries a Keep-Alive: timeout=<seconds> hint").not.toBeNull();
    expect(Number(hint![1]) * 1000).toBeGreaterThan(LONGEST_TEST_TIMEOUT_MS);
  } finally {
    await stop();
  }
});
