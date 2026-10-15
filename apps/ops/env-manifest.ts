/**
 * The one list of every environment variable the operator console (apps/ops) reads or will read.
 *
 * `apps/ops` is its own Vercel project with its own settings: none of these names may appear in `apps/web`'s manifest
 * (apps/ops/test/env-manifests.test.ts checks that), and `apps/ops` never lists a platform_ops, app_user, tenant-session,
 * KEK or Stripe name. Names only: no value of any variable belongs in this file.
 *
 * `required` names are checked by /api/health, which answers 503 with the name (never the value) when one is missing or
 * malformed. The rest belong to later OPS rows (alerts, email, the operator account list) and are listed here so the
 * owner sets everything on the project once; each says what happens while it is missing.
 */

export type MissingEffect = "request_fails" | "feature_disabled" | "none";

export type Check = "postgres-url" | "min-chars-32" | "origin" | "https-url" | "email" | "any";

export interface OpsEnvVar {
  name: string;
  /** Checked by /api/health: missing or malformed is a 503. */
  required: boolean;
  secret: boolean;
  check: Check;
  feature: string;
  whenMissing: MissingEffect;
  note: string;
}

export const OPS_ENV_MANIFEST: readonly OpsEnvVar[] = [
  { name: "DATABASE_URL_OPS_CONSOLE", required: true, secret: true, check: "postgres-url", feature: "Database", whenMissing: "request_fails", note: "The only database login this app holds (the ops_console role). Every signed-in request, sign-in and enrollment fails; /api/health answers 503" },
  { name: "FX_OPS_SESSION_SECRET", required: true, secret: true, check: "min-chars-32", feature: "Staff sessions", whenMissing: "request_fails", note: "Sessions and challenges cannot be signed or verified; nobody can sign in, and /api/health answers 503" },
  { name: "FX_OPS_ORIGIN", required: true, secret: false, check: "origin", feature: "Passkeys and the CSRF origin check", whenMissing: "request_fails", note: "Every POST is refused (403) and passkeys cannot be verified; /api/health answers 503. Must equal the browser's Origin exactly, no trailing slash" },
  { name: "FX_OPS_ALERT_WEBHOOK_URL", required: false, secret: true, check: "https-url", feature: "Operator alerts (webhook)", whenMissing: "feature_disabled", note: "Read by the alerting row (OPS-T4b). The webhook channel stays off" },
  { name: "FX_OPS_ALERT_EMAIL", required: false, secret: false, check: "email", feature: "Operator alerts (email)", whenMissing: "feature_disabled", note: "Read by the alerting row (OPS-T4b). The email channel stays off" },
  { name: "CRON_SECRET", required: false, secret: true, check: "min-chars-32", feature: "Scheduled jobs on this project", whenMissing: "feature_disabled", note: "Read by later rows with a cron route here. Those routes refuse every call (fail closed)" },
  { name: "RESEND_API_KEY", required: false, secret: true, check: "any", feature: "Email sending", whenMissing: "feature_disabled", note: "Read by the alerting and support rows. Nothing is sent" },
  { name: "FX_SUPPORT_FROM_ADDRESS", required: false, secret: false, check: "email", feature: "Support replies", whenMissing: "feature_disabled", note: "Read by the staff inbox row (OPS-S1-b). The reply button is disabled with 'Support sending address not set'" },
  { name: "FX_OPERATOR_ACCOUNT_IDS", required: false, secret: false, check: "any", feature: "Operator economics page", whenMissing: "feature_disabled", note: "Read by the economics row (OPS-A3). The page shows 'Operator accounts not set' and hides every figure (fail closed)" },
];
