import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIssueLabelLookup, createLoginPermissionLookup, InstallationTokenCache } from "@fx/github";
import { defaultGithubWebhookDeps } from "../../app/api/github/webhook/handler";
import { issueHasLabel, SENDER_LOOKUP_DEADLINE_MS, senderPermission, underDeadline } from "./senderPermission";

afterEach(() => vi.unstubAllEnvs());

describe("the webhook's product-label sender lookup (D#483)", () => {
  it("is wired into the webhook's production deps", () => {
    vi.stubEnv("DATABASE_URL_APP_USER", "postgres://u:p@127.0.0.1:1/none");
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://u:p@127.0.0.1:1/none");
    expect(defaultGithubWebhookDeps().senderPermission).toBe(senderPermission);
    expect(defaultGithubWebhookDeps().issueHasLabel).toBe(issueHasLabel);
  });

  it("fails closed: with nothing to read the installation from it throws, and the webhook then does not honour the label", async () => {
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "");
    await expect(senderPermission({ repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets", login: "boss" })).rejects.toThrow();
  });
});

describe("the sender lookup's one deadline covers the installation token mint too (D#483)", () => {
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
  const call = { repoId: "r", owner: "acme", name: "widgets", login: "boss" };
  const lookupWith = (requester: Parameters<typeof createLoginPermissionLookup>[0]["requester"], fetchImpl: typeof fetch) =>
    createLoginPermissionLookup({ resolveInstallation: async () => ({ installationId: 1, appKind: "team" }), appCredentials: () => ({ appId: "1", privateKeyPem: pem, webhookSecret: "unused" }), requester, cache: new InstallationTokenCache(), fetchImpl });

  it("is 8 seconds", () => {
    expect(SENDER_LOOKUP_DEADLINE_MS).toBe(8_000);
  });

  it("a mint that never answers is cut off at the deadline and the lookup throws, so the label is not honoured (fail closed)", async () => {
    const fetchImpl = vi.fn();
    const lookup = lookupWith(() => new Promise(() => {}), fetchImpl as unknown as typeof fetch);
    const started = Date.now();
    await expect(underDeadline((signal) => lookup({ ...call, signal }), 50)).rejects.toThrow("deadline");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a mint that answers just inside the deadline and a permission call that then hangs are cut off by the same deadline, not given a fresh one", async () => {
    const fetchImpl = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))));
    const lookup = lookupWith(() => new Promise((r) => setTimeout(() => r({ token: "t", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), 60)), fetchImpl as unknown as typeof fetch);
    const started = Date.now();
    await expect(underDeadline((signal) => lookup({ ...call, signal }), 120)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a lookup that answers in time gives its answer, and one that throws gives its own error", async () => {
    const ok = lookupWith(async () => ({ token: "t", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), (async () => new Response(JSON.stringify({ role_name: "maintain", permission: "write" }), { status: 200 })) as unknown as typeof fetch);
    expect(await underDeadline((signal) => ok({ ...call, signal }), 5_000)).toBe("maintain");
    await expect(underDeadline(async () => { throw new Error("boom"); }, 5_000)).rejects.toThrow("boom");
  });

  const labelLookup = (requester: Parameters<typeof createLoginPermissionLookup>[0]["requester"], fetchImpl: typeof fetch) =>
    createIssueLabelLookup({ resolveInstallation: async () => ({ installationId: 1, appKind: "team" }), appCredentials: () => ({ appId: "1", privateKeyPem: pem, webhookSecret: "unused" }), requester, cache: new InstallationTokenCache(), fetchImpl });
  const okToken = async () => ({ token: "t", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const issue = { repoId: "r", owner: "acme", name: "widgets", number: 7, label: "fulcrumaxe:product" };

  it("the live label read answers from the issue's labels, and a mint that never answers or a read that fails throws within the deadline (no flip)", async () => {
    const answer = (labels: unknown, status = 200) => (async () => new Response(JSON.stringify({ labels }), { status })) as unknown as typeof fetch;
    expect(await underDeadline((signal) => labelLookup(okToken, answer([{ name: "bug" }, { name: "fulcrumaxe:product" }]))({ ...issue, signal }), 5_000)).toBe(true);
    expect(await underDeadline((signal) => labelLookup(okToken, answer([{ name: "bug" }]))({ ...issue, signal }), 5_000)).toBe(false);
    await expect(underDeadline((signal) => labelLookup(okToken, answer([], 500))({ ...issue, signal }), 5_000)).rejects.toThrow("read_failed");
    await expect(underDeadline((signal) => labelLookup(okToken, answer("none"))({ ...issue, signal }), 5_000)).rejects.toThrow("no_labels");
    const fetchImpl = vi.fn();
    await expect(underDeadline((signal) => labelLookup(() => new Promise(() => {}), fetchImpl as unknown as typeof fetch)({ ...issue, signal }), 50)).rejects.toThrow("deadline");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
