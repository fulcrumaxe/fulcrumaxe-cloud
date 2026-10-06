import type { Pool } from "pg";
import { createPool } from "@fx/db/src/pool";
import {
  GitHubOAuthProvider,
  TestOnlyProvider,
  githubOAuthConfigFromEnv,
  type AuthProvider,
  type ExternalIdentity,
} from "@fx/core/src/auth/provider";

export interface AuthDeps {
  platformOpsPool: Pool;
  appUserPool: Pool;
}

let cachedDeps: AuthDeps | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

/**
 * Lazily builds (and caches) the real Postgres pools from env. Only
 * reached from a route's own exported GET/POST default parameter --
 * every test in this repo calls a route's inner handler function
 * directly with injected fake deps, so this constructor never runs
 * under `pnpm test` (root `pnpm test` has no DATABASE_URL_* set at all).
 */
export function defaultAuthDeps(): AuthDeps {
  if (!cachedDeps) {
    cachedDeps = {
      platformOpsPool: createPool(requireEnv("DATABASE_URL_PLATFORM_OPS")),
      appUserPool: createPool(requireEnv("DATABASE_URL_APP_USER")),
    };
  }
  return cachedDeps;
}

export function defaultGithubProvider(): AuthProvider {
  return new GitHubOAuthProvider(githubOAuthConfigFromEnv());
}

export function defaultTestProvider(identity: ExternalIdentity): AuthProvider {
  return new TestOnlyProvider(identity);
}
