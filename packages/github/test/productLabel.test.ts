import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RepoPermission } from "@fx/trust";
import { PRODUCT_LABEL } from "@fx/core/src/plan/ownerProcess.js";
import { mapEvent, type GithubWebhookPayload } from "../src/eventMapper.js";
import { createLoginPermissionLookup } from "../src/loginPermission.js";
import { InstallationTokenCache } from "../src/installationToken.js";
import { productLabelDelivery } from "../src/productLabel.js";

/** GitHub's own shape for `issues.labeled` / `.unlabeled`: the `label` object, the `sender`, the issue. */
function payload(over: { action?: string; label?: string | null; state?: string; pull?: boolean; sender?: unknown; number?: unknown } = {}): GithubWebhookPayload {
  return {
    action: over.action ?? "labeled",
    issue: { number: over.number ?? 7, title: "t", body: "b", user: { login: "someone" }, author_association: "NONE", state: over.state ?? "open", created_at: "2026-11-01T00:00:00Z", ...(over.pull ? { pull_request: { url: "https://api.github.com/x" } } : {}) },
    ...(over.label === null ? {} : { label: { id: 1, name: over.label ?? PRODUCT_LABEL, color: "ededed", default: false, description: null } }),
    sender: over.sender === undefined ? { login: "boss", id: 5, type: "User" } : over.sender,
  } as unknown as GithubWebhookPayload;
}

describe("productLabelDelivery: which deliveries are the product label at all (no other label costs a permission read)", () => {
  it("accepts labeled on an open issue and unlabeled on any issue, for exactly the label, with a named sender", () => {
    expect(productLabelDelivery("issues", payload())).toEqual({ action: "labeled", ghNumber: 7, senderLogin: "boss" });
    expect(productLabelDelivery("issues", payload({ action: "unlabeled", state: "closed" }))).toEqual({ action: "unlabeled", ghNumber: 7, senderLogin: "boss" });
  });

  it("refuses another label, a near miss of the name, another event, another action, a pull request, a closed labeled issue, a bad number and no sender", () => {
    for (const bad of [
      payload({ label: "bug" }),
      payload({ label: `${PRODUCT_LABEL} ` }),
      payload({ label: PRODUCT_LABEL.toUpperCase() }),
      payload({ label: null }),
      payload({ action: "opened" }),
      payload({ action: "edited" }),
      payload({ pull: true }),
      payload({ state: "closed" }),
      payload({ number: 0 }),
      payload({ number: 2147483648 }),
      payload({ number: "7" }),
      payload({ sender: null }),
      payload({ sender: { login: "" } }),
      payload({ sender: { login: 5 } }),
    ]) {
      expect(productLabelDelivery("issues", bad)).toBeNull();
    }
    expect(productLabelDelivery("issue_comment", payload())).toBeNull();
    expect(productLabelDelivery("issues", null)).toBeNull();
  });
});

describe("mapEvent: the sender's permission decides, and only maintain or admin act", () => {
  const map = (action: string, permission: RepoPermission | null | undefined) => mapEvent("issues", payload({ action }), { allowlist: [], labelSenderPermission: permission });

  it("maps labeled and unlabeled of the label to a product_label event for maintain and admin", () => {
    for (const permission of ["maintain", "admin"] as const) {
      expect(map("labeled", permission)).toEqual({ kind: "product_label", change: "labeled", ghNumber: 7, permission });
      expect(map("unlabeled", permission)).toEqual({ kind: "product_label", change: "unlabeled", ghNumber: 7, permission });
    }
  });

  it("ignores every other permission, an unread one and an unwired one (the event then acts as any other label did before)", () => {
    for (const permission of ["write", "triage", "read", "none", null, undefined] as const) {
      expect(map("labeled", permission)).toMatchObject({ kind: "ignored" });
      expect(map("unlabeled", permission)).toMatchObject({ kind: "ignored" });
    }
  });

  it("ignores another label even from an admin, and a closed issue's label", () => {
    expect(mapEvent("issues", payload({ label: "bug" }), { allowlist: [], labelSenderPermission: "admin" })).toMatchObject({ kind: "ignored" });
    expect(mapEvent("issues", payload({ state: "closed" }), { allowlist: [], labelSenderPermission: "admin" })).toMatchObject({ kind: "ignored" });
  });
});

const pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;

describe("the login permission lookup (the sender's real role)", () => {
  function lookupWith(fetchImpl: typeof fetch) {
    return createLoginPermissionLookup({
      resolveInstallation: async () => ({ installationId: 1, appKind: "team" }),
      appCredentials: () => ({ appId: "1", privateKeyPem: pem, webhookSecret: "unused" }),
      requester: async () => ({ token: "t", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
      cache: new InstallationTokenCache(),
      fetchImpl,
    });
  }
  const call = { repoId: "r", owner: "acme", name: "widgets" };

  it("makes no call for a login GitHub could not have issued (a bot's suffix, a slash) and reads it as none", async () => {
    const fetchImpl = vi.fn();
    const lookup = lookupWith(fetchImpl as unknown as typeof fetch);
    expect(await lookup({ ...call, login: "dependabot[bot]" })).toBe("none");
    expect(await lookup({ ...call, login: "a/../b" })).toBe("none");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the role name, not the legacy four-level answer (maintain reads as `write` there), and a 404 is none", async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await lookupWith(answer(200, { permission: "write", role_name: "maintain" }))({ ...call, login: "boss" })).toBe("maintain");
    expect(await lookupWith(answer(200, { permission: "admin", role_name: "admin" }))({ ...call, login: "boss" })).toBe("admin");
    expect(await lookupWith(answer(404, { message: "Not Found" }))({ ...call, login: "boss" })).toBe("none");
  });

  it("throws a fixed message for a server error and a network failure, never naming the login", async () => {
    const failing = (async () => new Response("{}", { status: 502 })) as unknown as typeof fetch;
    await expect(lookupWith(failing)({ ...call, login: "secret-login" })).rejects.toThrow(/permission_failed \(502\)/);
    const down = (async () => {
      throw new Error("connect ECONNREFUSED for secret-login");
    }) as unknown as typeof fetch;
    const err = await lookupWith(down)({ ...call, login: "secret-login" }).catch((e: Error) => e);
    expect((err as Error).message).toBe("loginPermission: request_failed");
  });
});
