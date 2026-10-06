import { createPrivateKey } from "node:crypto";
import { INSTALLATION_APP_KINDS, type InstallationAppKind } from "@fx/core/src/repos/appKinds.js";

/**
 * D#2 H13e (D#31 C23 rulings 1 and 2): GitHub App credentials chosen by the
 * installation's `app_kind`. A GitHub installation belongs to exactly one
 * App and only that App's key can mint its tokens, so the kind decides which
 * id, private key and webhook secret apply.
 *
 * Fail closed, per kind: a kind whose id is not a positive integer, whose
 * key does not parse, or whose webhook secret is empty or under 32 bytes is
 * NOT configured and refuses; the other kinds are unaffected. There is no
 * fallback from one kind to another. Two kinds sharing one App id refuse
 * every kind. Every error is a fixed string naming the kind or the
 * environment variables, never a value.
 */

export type AppKind = InstallationAppKind;

export interface AppCredentials {
  appId: string;
  privateKeyPem: string;
  webhookSecret: string;
}

export type AppCredentialsSource = (kind: unknown) => AppCredentials;

/** The `team` names are unchanged from H13b (C23 ruling 2). */
export const APP_ENV_NAMES: Record<AppKind, { appId: string; privateKey: string; webhookSecret: string }> = {
  team: {
    appId: "GITHUB_APP_ID",
    privateKey: "GITHUB_APP_PRIVATE_KEY_PEM",
    webhookSecret: "GITHUB_WEBHOOK_SECRET",
  },
  team_readonly: {
    appId: "GITHUB_APP_TEAM_READONLY_ID",
    privateKey: "GITHUB_APP_TEAM_READONLY_PRIVATE_KEY_PEM",
    webhookSecret: "GITHUB_APP_TEAM_READONLY_WEBHOOK_SECRET",
  },
  sitekit: {
    appId: "GITHUB_APP_SITEKIT_ID",
    privateKey: "GITHUB_APP_SITEKIT_PRIVATE_KEY_PEM",
    webhookSecret: "GITHUB_APP_SITEKIT_WEBHOOK_SECRET",
  },
};

const MIN_WEBHOOK_SECRET_BYTES = 32;

export class AppCredentialsError extends Error {
  constructor(message: string) {
    super(`appCredentials: ${message}`);
    this.name = "AppCredentialsError";
  }
}

function isKind(kind: unknown): kind is AppKind {
  return typeof kind === "string" && (INSTALLATION_APP_KINDS as readonly string[]).includes(kind);
}

/**
 * Why a partly configured kind was refused. Shape-only: fixed check names,
 * variable names, lengths, byte counts and flags. Never a value, never a
 * prefix of one.
 */
export interface AppCredentialsProblem {
  kind: AppKind;
  /** Each failing check, by fixed name. */
  checks: string[];
  /** The variable each check is about, in the same order. */
  variables: string[];
  facts: Record<string, number | boolean>;
}

type ParseResult = { ok: AppCredentials } | { problem: AppCredentialsProblem } | null;

function parseKind(kind: AppKind, env: Record<string, string | undefined>): ParseResult {
  const names = APP_ENV_NAMES[kind];
  const appId = env[names.appId];
  const privateKeyPem = env[names.privateKey];
  const webhookSecret = env[names.webhookSecret];
  // Nothing set at all: the kind is not in use here, which is not a mistake.
  if (!appId && !privateKeyPem && !webhookSecret) return null;

  const checks: string[] = [];
  const variables: string[] = [];
  const facts: Record<string, number | boolean> = {};
  const fail = (check: string, variable: string) => {
    checks.push(check);
    variables.push(variable);
  };

  if (!appId) fail("id_missing", names.appId);
  else if (!/^[1-9][0-9]*$/.test(appId) || !Number.isSafeInteger(Number(appId))) {
    fail("id_not_digits", names.appId);
    facts.id_length = appId.length;
  }

  if (!privateKeyPem) fail("pem_missing", names.privateKey);
  else {
    const hasBegin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKeyPem);
    const hasEnd = /-----END [A-Z ]*PRIVATE KEY-----/.test(privateKeyPem);
    let parses = false;
    if (hasBegin && hasEnd) {
      try {
        createPrivateKey(privateKeyPem);
        parses = true;
      } catch {
        parses = false;
      }
    }
    if (!parses) {
      fail(hasBegin && hasEnd ? "pem_unparseable" : "pem_missing_begin_end_lines", names.privateKey);
      facts.pem_length = privateKeyPem.length;
      facts.pem_has_begin_line = hasBegin;
      facts.pem_has_end_line = hasEnd;
    }
  }

  if (!webhookSecret) fail("webhook_secret_missing", names.webhookSecret);
  else if (Buffer.byteLength(webhookSecret, "utf8") < MIN_WEBHOOK_SECRET_BYTES) {
    fail("webhook_secret_under_32_bytes", names.webhookSecret);
    facts.webhook_secret_bytes = Buffer.byteLength(webhookSecret, "utf8");
  }

  if (checks.length > 0 || !appId || !privateKeyPem || !webhookSecret) return { problem: { kind, checks, variables, facts } };
  return { ok: { appId, privateKeyPem, webhookSecret } };
}

/** Problems this process already reported, so a loader called on every request logs each one once. */
const reported = new Set<string>();

/** Test hook: forget what was reported. */
export function resetAppCredentialsWarnings(): void {
  reported.clear();
}

function reportProblem(problem: AppCredentialsProblem, warn: (line: string) => void): void {
  const line = JSON.stringify({ event: "appcreds.invalid", ...problem });
  if (reported.has(line)) return;
  reported.add(line);
  warn(line);
}

/**
 * Reads the three kinds' configuration from `env` once. Never throws: an
 * unconfigured kind, or a duplicated App id, surfaces when the returned
 * source is asked for that kind's credentials.
 *
 * A kind with SOME of its three variables set that still fails validation
 * is almost always a paste mistake (an App's client secret in the key
 * variable, say). It is reported once per process as one structured warning
 * naming the kind, the failing checks and the variables, with shape-only
 * facts. A kind with none set stays silent.
 */
export function loadAppCredentials(
  env: Record<string, string | undefined>,
  warn: (line: string) => void = (line) => console.warn(line),
): AppCredentialsSource {
  const configured = new Map<AppKind, AppCredentials>();
  for (const kind of INSTALLATION_APP_KINDS) {
    const parsed = parseKind(kind, env);
    if (!parsed) continue;
    if ("ok" in parsed) configured.set(kind, parsed.ok);
    else reportProblem(parsed.problem, warn);
  }

  const idOwner = new Map<string, AppKind>();
  let duplicateOf: [AppKind, AppKind] | null = null;
  for (const [kind, creds] of configured) {
    const other = idOwner.get(creds.appId);
    if (other) duplicateOf = [other, kind];
    else idOwner.set(creds.appId, kind);
  }

  return (kind) => {
    if (duplicateOf) {
      throw new AppCredentialsError(
        `duplicate_app_id (${APP_ENV_NAMES[duplicateOf[0]].appId}, ${APP_ENV_NAMES[duplicateOf[1]].appId})`,
      );
    }
    if (!isKind(kind)) throw new AppCredentialsError("unknown_app_kind");
    const creds = configured.get(kind);
    if (!creds) throw new AppCredentialsError(`not_configured (${kind})`);
    return creds;
  };
}
