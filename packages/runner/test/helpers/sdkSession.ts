import type { SdkSandbox } from "../../src/vercelSandboxPort.js";

/** The session-related members of an `SdkSandbox` fake: running, one session, nothing listed. */
export function sdkSessionStubs(sessionId = "sess-1"): Pick<SdkSandbox, "status" | "currentSession" | "listSessions"> {
  return {
    status: "running",
    currentSession: () => ({ sessionId }),
    listSessions: async () => ({ sessions: [], pagination: { next: null } }),
  };
}
