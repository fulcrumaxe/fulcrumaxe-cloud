import { randomInt, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { SeedRefs } from "@fx/db/test/helpers/seed.js";

/** D#2 H17c-2b: a seeded preview target (a repo on a live installation, with its installer record). */
export interface SeededTarget {
  repoId: string;
  ghUserId: number;
  ghInstallationId: number;
}

/** A repo (named <ghOwner>/widgets on GitHub, a distinct owner per call unless given) on a live installation of `kind`, with its installer record. */
export async function seedPreviewTarget(admin: PoolClient, account: SeedRefs, kind: "team_readonly" | "team" | "sitekit" = "team_readonly", ghOwner?: string): Promise<SeededTarget> {
  const installationId = randomUUID();
  const repoId = randomUUID();
  const ghInstallationId = randomInt(1, 2_000_000_000);
  const ghUserId = randomInt(1, 2_000_000_000);
  await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [installationId, account.accountId, ghInstallationId, kind]);
  await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, $5, $6, 'widgets')`, [
    repoId,
    account.accountId,
    installationId,
    randomInt(1, 2_000_000_000),
    kind === "sitekit" ? "sitekit" : "team",
    ghOwner ?? `o${ghInstallationId}`,
  ]);
  await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, $2, $3)`, [ghInstallationId, kind, ghUserId]);
  return { repoId, ghUserId, ghInstallationId };
}
