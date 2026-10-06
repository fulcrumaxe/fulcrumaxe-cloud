import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * route.ts itself is a thin, Next-router-shaped wrapper (see handler.ts's
 * header for why the real logic can't live in the exported `POST`
 * directly). All of the route's actual behavior -- body/schema handling
 * and the fix round 1 rate limiting -- is covered in handler.test.ts
 * against `handleRumPost` directly. This file only proves the wrapper
 * itself delegates, with `./handler` mocked so it never needs a real
 * rate-limit store or database connection.
 */
vi.mock("./handler", () => ({
  handleRumPost: vi.fn(async () => new Response(null, { status: 204 })),
}));

describe("POST /api/rum (route wrapper)", () => {
  it("delegates to handleRumPost with just the request, and returns its response", async () => {
    const { handleRumPost } = await import("./handler");
    const { POST } = await import("./route");

    const req = new NextRequest("https://example.test/api/rum", { method: "POST" });
    const res = await POST(req);

    expect(handleRumPost).toHaveBeenCalledTimes(1);
    expect(handleRumPost).toHaveBeenCalledWith(req);
    expect(res.status).toBe(204);
  });
});
