import { afterEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({ check: null as null | { lookup: (r: unknown) => Promise<unknown>; allowlist: string[] } }));
vi.mock("./authorCheck", () => ({ getAuthorCheck: () => world.check }));

import { defaultGithubWebhookDeps } from "../../app/api/github/webhook/handler";
import { issueAuthorPermission, LOOKUP_DEADLINE_MS } from "./issueAuthorPermission";

const INPUT = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets", number: 7 };
afterEach(() => {
  world.check = null;
  vi.unstubAllEnvs();
});

describe("the webhook's author-permission lookup (D#483 P1)", () => {
  it("reuses the retry author check's lookup and reports the login and permission of a found issue", async () => {
    const lookup = vi.fn(async () => ({ status: "found", login: "org-owner", permission: "admin" }));
    world.check = { lookup, allowlist: [] };
    expect(await issueAuthorPermission(INPUT)).toEqual({ login: "org-owner", permission: "admin" });
    expect(lookup).toHaveBeenCalledWith({ ...INPUT, signal: expect.any(AbortSignal) });
  });

  it("the lookup is bounded by a deadline signal", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    world.check = { lookup: async () => ({ status: "missing" }), allowlist: [] };
    await issueAuthorPermission(INPUT);
    expect(spy).toHaveBeenCalledWith(LOOKUP_DEADLINE_MS);
    spy.mockRestore();
  });

  it("fails closed: a missing issue and no check at all answer null, and a throw propagates for the webhook to swallow", async () => {
    world.check = { lookup: async () => ({ status: "missing" }), allowlist: [] };
    expect(await issueAuthorPermission(INPUT)).toBeNull();
    world.check = null;
    expect(await issueAuthorPermission(INPUT)).toBeNull();
    world.check = {
      lookup: async () => {
        throw new Error("issueAuthorLookup: issue_failed (503)");
      },
      allowlist: [],
    };
    await expect(issueAuthorPermission(INPUT)).rejects.toThrow("issue_failed");
  });

  it("is wired into the webhook's production deps", () => {
    vi.stubEnv("DATABASE_URL_APP_USER", "postgres://u:p@127.0.0.1:1/none");
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://u:p@127.0.0.1:1/none");
    expect(defaultGithubWebhookDeps().issueAuthorPermission).toBe(issueAuthorPermission);
  });
});
