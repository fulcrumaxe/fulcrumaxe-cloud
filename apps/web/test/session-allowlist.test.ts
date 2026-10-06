import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, signSession } from "@fx/core/src/auth/session";
import { fakePlatformOpsPool } from "../app/api/auth/_lib/testFakes";
import { resolveActiveSession } from "../lib/shell/session-guard";

/**
 * Staging lock: a session minted before FX_SIGNIN_ALLOWLIST changed is
 * refused on its next request once its login is no longer listed. The
 * enforcement point is getSessionEpochAndRevocation, which resolveActiveSession
 * (and the API principal and event stream) call on every request.
 */
const env = { FX_SESSION_SECRET: "c".repeat(32) } as unknown as NodeJS.ProcessEnv;
const userId = "0a0a0a0a-1111-2222-3333-0a0a0a0a0a0a";
const accountId = "0b0b0b0b-1111-2222-3333-0b0b0b0b0b0b";

afterEach(() => {
  delete process.env.FX_SIGNIN_ALLOWLIST;
});

async function resolveWith(allowlist: string | undefined, githubLogin: string | null) {
  if (allowlist === undefined) delete process.env.FX_SIGNIN_ALLOWLIST;
  else process.env.FX_SIGNIN_ALLOWLIST = allowlist;
  const token = await signSession({ userId, accountId }, env, { epoch: 0 });
  const req = new NextRequest("https://example.test/api/shell/session", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  const pool = fakePlatformOpsPool({ existingUser: { id: userId, email: "x@example.test", name: null, githubLogin } });
  return resolveActiveSession(req, { platformOpsPool: pool }, { env });
}

describe("existing sessions and FX_SIGNIN_ALLOWLIST", () => {
  it("keeps a listed login's session (any case)", async () => {
    expect(await resolveWith("Tester", "tester")).not.toBeNull();
  });

  it("refuses a login that is no longer listed", async () => {
    expect(await resolveWith("someone-else", "tester")).toBeNull();
  });

  it("refuses a row with no recorded login while the lock is on", async () => {
    expect(await resolveWith("tester", null)).toBeNull();
  });

  it("restricts nothing when unset, empty or blank-only", async () => {
    for (const value of [undefined, "", " , "]) {
      expect(await resolveWith(value, "tester")).not.toBeNull();
    }
  });
});
