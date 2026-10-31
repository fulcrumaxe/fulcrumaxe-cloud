import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronAuthorized } from "../lib/cronAuth";

const ROUTE = "/api/cron/api-sweep";
const SECRET = "s3cret-value-for-cron-auth";
let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
  vi.spyOn(console, "error").mockImplementation((l: unknown) => void lines.push(String(l)));
  vi.spyOn(console, "warn").mockImplementation((l: unknown) => void lines.push(String(l)));
  vi.spyOn(console, "info").mockImplementation((l: unknown) => void lines.push(String(l)));
  vi.spyOn(console, "debug").mockImplementation((l: unknown) => void lines.push(String(l)));
});
afterEach(() => vi.restoreAllMocks());

describe("cronAuthorized", () => {
  it("accepts the right bearer and logs nothing", () => {
    expect(cronAuthorized(ROUTE, `Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(lines).toEqual([]);
  });

  it("logs one cron.refused line with reason missing when there is no header", () => {
    expect(cronAuthorized(ROUTE, null, SECRET)).toBe(false);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: "cron.refused", route: ROUTE, reason: "missing" }]);
  });

  it("logs reason missing when no secret is configured", () => {
    expect(cronAuthorized(ROUTE, "Bearer ", "")).toBe(false);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: "cron.refused", route: ROUTE, reason: "missing" }]);
  });

  it("logs one cron.refused line with reason mismatch for a wrong header", () => {
    expect(cronAuthorized(ROUTE, "Bearer wrong-secret", SECRET)).toBe(false);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: "cron.refused", route: ROUTE, reason: "mismatch" }]);
  });

  it("never logs the header value, the env value, or a length, for any refusal", () => {
    const wrongSameLength = `Bearer ${"x".repeat(SECRET.length)}`;
    const headers = [null, "Bearer short", wrongSameLength, `Bearer ${SECRET}x`];
    for (const h of headers) cronAuthorized(ROUTE, h, SECRET);
    cronAuthorized(ROUTE, wrongSameLength, "");
    expect(lines).toHaveLength(headers.length + 1);
    const out = lines.join("\n");
    expect(out).not.toContain(SECRET);
    for (const h of headers) if (h) expect(out).not.toContain(h);
    expect(out).not.toContain("xxxx");
    expect(out).not.toMatch(/length|len\b/i);
    for (const l of lines) expect(Object.keys(JSON.parse(l)).sort()).toEqual(["event", "reason", "route"]);
  });
});
