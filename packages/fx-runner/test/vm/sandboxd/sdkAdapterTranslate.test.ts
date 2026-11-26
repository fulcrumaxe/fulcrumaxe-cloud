import { describe, expect, it } from "vitest";
import { AgentError } from "../../../src/vm/sandboxd/agentError.js";
import { SandboxdError } from "../../../src/vm/sandboxd/sandboxd.js";
import { SandboxdSdkError, translated } from "../../../src/vm/sandboxd/sdkAdapter.js";

describe("the adapter's error translation", () => {
  it("keeps a guest agent failure's closed code instead of calling it internal", () => {
    for (const code of ["unreachable", "bad_reply", "refused", "timeout", "bad_request", "lost", "unsupported"] as const) {
      const out = translated(new AgentError(code));
      expect(out).toBeInstanceOf(SandboxdSdkError);
      expect(out.response.status).toBe(502);
      expect(out.json.error.code).toBe(`guest_${code}`);
    }
  });
  it("keeps a daemon refusal's status and code", () => {
    const out = translated(new SandboxdError(409, "not_running"));
    expect([out.response.status, out.json.error.code]).toEqual([409, "not_running"]);
  });
  it("still maps anything else to a bare 500 internal", () => {
    const out = translated(new TypeError("secret detail"));
    expect([out.response.status, out.json.error.code, out.message]).toEqual([500, "internal", "fx-sandboxd adapter: internal"]);
  });
});
