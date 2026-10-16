/**
 * Role fixtures (T3): `test.use({ sessionRole: "owner" })` in a spec file, then `({ page, session })` in a test.
 * The role's stored app cookie is in the browser context before the first navigation, `session.api` is the shared
 * client acting as that role, and the newest cookie the app set is written back to the store after the test, so the
 * sliding session keeps sliding (src/session-fixture.ts holds the logic and its tests). A pack uses a role only
 * when it declares `session:<role>` in pack.json, which is what makes the runner pass the key and skip otherwise.
 */
import { join } from "node:path";
import { packageRoot } from "../src/limits.js";
import { openSession, type OpenSession } from "../src/session-fixture.js";
import type { Role } from "../src/store.js";
import { test as base } from "./bypass.js";

interface SessionFixtures {
  sessionRole: Role;
  session: OpenSession;
}

export const test = base.extend<SessionFixtures>({
  sessionRole: ["owner", { option: true }],
  session: async ({ context, target, sessionRole }, use) => {
    const open = await openSession({ target, targetsDir: join(packageRoot(), "targets"), env: process.env, role: sessionRole, context });
    try {
      await use(open);
    } finally {
      await open.finish();
    }
  },
});

export { expect } from "@playwright/test";
