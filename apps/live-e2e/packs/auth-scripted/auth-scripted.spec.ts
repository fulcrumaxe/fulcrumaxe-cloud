// auth-scripted pack, rows A2 (callback gives a session and boots the desktop), A3 (a login not on the allowlist gets the
// plain 403 and no session) and A6 (an invited login joins with the invited role).
//
// Each needs a fresh real GitHub sign-in of a machine account, which only option A (scripted TOTP logins) provides, and
// option A is not adopted. Until it is, the pack's `signin:scripted` need is never met, so the runner reports
// SKIPPED-NEED signin:scripted and starts none of this file. There is no sign-in driver here yet: if the need is ever
// met before one is written, each test FAILS with the line below rather than passing on nothing.
import { test } from "../../fixtures/bypass.js";

const NOT_BUILT = "no scripted sign-in exists yet: the option A adoption PR writes this driver, and adds the signin:scripted:<role> need form with it";

test.describe("A2 callback", () => {
  test("an allowlisted login gets __Host-fx_session and boots to the desktop", () => {
    throw new Error(NOT_BUILT);
  });
});

test.describe("A3 allowlist", () => {
  test("a login that is not listed gets the plain 403 and no session", () => {
    throw new Error(NOT_BUILT);
  });
});

test.describe("A6 invitation", () => {
  test("an invited login joins with the invited role", () => {
    throw new Error(NOT_BUILT);
  });
});
