import { describe, expect, it } from "vitest";
import { CachedHostResolver, UNKNOWN_HOST, type HostResolver, type ResolvedHost } from "../src/host/index.js";

function active(name: string): ResolvedHost {
  return { ...UNKNOWN_HOST, partnerId: "11111111-1111-4111-8111-111111111111", productName: name, state: "active" };
}

function fakeInner(answers: Record<string, ResolvedHost>): HostResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(hostname) {
      calls.push(hostname);
      return answers[hostname] ?? UNKNOWN_HOST;
    },
  };
}

describe("CachedHostResolver", () => {
  it("never shares an entry between two hosts", async () => {
    const inner = fakeInner({ "a.example.com": active("A"), "b.example.com": active("B") });
    const cache = new CachedHostResolver(inner, { now: () => 0 });
    expect((await cache.resolve("a.example.com")).productName).toBe("A");
    expect((await cache.resolve("b.example.com")).productName).toBe("B");
    expect((await cache.resolve("a.example.com")).productName).toBe("A");
    expect(inner.calls).toEqual(["a.example.com", "b.example.com"]);
  });

  it("shows a change within 60 seconds (fake clock), and not before the entry is due", async () => {
    let now = 1_000;
    const answers: Record<string, ResolvedHost> = { "a.example.com": active("Old") };
    const inner = fakeInner(answers);
    const cache = new CachedHostResolver(inner, { now: () => now });
    expect((await cache.resolve("a.example.com")).productName).toBe("Old");

    answers["a.example.com"] = active("New");
    now += 59_999;
    expect((await cache.resolve("a.example.com")).productName).toBe("Old");
    now += 1;
    expect((await cache.resolve("a.example.com")).productName).toBe("New");
    expect(inner.calls).toHaveLength(2);
  });

  it("does not store an error", async () => {
    let fail = true;
    const inner: HostResolver = {
      async resolve() {
        if (fail) throw new Error("db down");
        return active("A");
      },
    };
    const cache = new CachedHostResolver(inner, { now: () => 0 });
    await expect(cache.resolve("a.example.com")).rejects.toThrow("db down");
    fail = false;
    expect((await cache.resolve("a.example.com")).state).toBe("active");
  });

  it("holds at most maxEntries hostnames, dropping the oldest", async () => {
    const inner = fakeInner({});
    const cache = new CachedHostResolver(inner, { now: () => 0, maxEntries: 2 });
    await cache.resolve("a.example.com");
    await cache.resolve("b.example.com");
    await cache.resolve("c.example.com");
    await cache.resolve("b.example.com");
    await cache.resolve("a.example.com");
    expect(inner.calls).toEqual(["a.example.com", "b.example.com", "c.example.com", "a.example.com"]);
  });
});
