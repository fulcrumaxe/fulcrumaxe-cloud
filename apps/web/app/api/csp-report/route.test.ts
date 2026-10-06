import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

describe("POST /api/csp-report", () => {
  it("accepts application/reports+json and returns 204 with no body", async () => {
    const req = new NextRequest("https://example.test/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/reports+json" },
      body: JSON.stringify([{ type: "csp-violation", body: { blockedURL: "https://evil.example/x.js" } }]),
    });
    const res = await POST(req);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("logs one structured line and stores nothing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const req = new NextRequest("https://example.test/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/reports+json" },
      body: JSON.stringify([{ type: "csp-violation" }]),
    });
    await POST(req);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toMatchObject({ event: "csp_report" });
    logSpy.mockRestore();
  });

  it("a malformed body never throws -- still answers 204", async () => {
    const req = new NextRequest("https://example.test/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/reports+json" },
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(204);
  });

  it("rejects a body over 16 KB via Content-Length with 413", async () => {
    const req = new NextRequest("https://example.test/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/reports+json", "content-length": String(17 * 1024) },
      body: "x",
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  // Security fix round item 6 (CWE-400): the real limit is enforced
  // against bytes actually read, not the declared Content-Length -- a
  // request that OMITS the header entirely (the common case for a
  // chunked or otherwise streamed body) must still be capped.
  it("rejects an oversized body with no Content-Length header at all (streamed byte-limit, not Content-Length-trusting)", async () => {
    const oversized = "x".repeat(20 * 1024); // 20 KB, over the 16 KB cap
    const req = new NextRequest("https://example.test/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/reports+json" },
      body: oversized,
    });
    expect(req.headers.get("content-length")).toBeNull();
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  // Security fix round item 6.
  it("rejects an unsupported content type with 415, even for an otherwise well-formed report", async () => {
    const req = new NextRequest("https://example.test/api/csp-report", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "[]",
    });
    const res = await POST(req);
    expect(res.status).toBe(415);
  });

  // Security fix round item 6: the route also accepts the older
  // report-uri media type, not just application/reports+json.
  it("accepts application/csp-report", async () => {
    const req = new NextRequest("https://example.test/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: JSON.stringify({ "csp-report": { "blocked-uri": "https://evil.example/x.js" } }),
    });
    const res = await POST(req);
    expect(res.status).toBe(204);
  });

  it("carries the criterion-13 security headers", async () => {
    const req = new NextRequest("https://example.test/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/reports+json" },
      body: "[]",
    });
    const res = await POST(req);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
