import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";

/**
 * Enrolls a staff member: creates the platform_staff row and one single-use enrollment token that expires in 15 minutes.
 * Only the SHA-256 of the token is stored; the token itself is printed once. It runs only with the migration credential
 * (DATABASE_URL): the console's own login (ops_console) has no right to write these tables, and the script refuses to start
 * when pointed at it. Usage: pnpm --filter ops enroll-staff --email <e> --name <n>
 */
export const ENROLLMENT_TTL_MINUTES = 15;

export interface EnrollResult {
  staffId: string;
  token: string;
  expiresAt: Date;
}

export async function enrollStaff(pool: pg.Pool, input: { email: string; name: string }): Promise<EnrollResult> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("--email must be an email address");
  if (name === "") throw new Error("--name is required");
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  // One statement, so the member and the token appear together or not at all. An existing member is re-enrolled (a lost
  // passkey): same row, a fresh token. A new member is inserted active.
  const { rows } = await pool.query<{ staff_id: string; expires_at: Date }>(
    `WITH s AS (
       INSERT INTO platform_staff (email, display_name) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id
     )
     INSERT INTO staff_enrollment_tokens (staff_id, token_hash, expires_at)
     SELECT id, $3, now() + make_interval(mins => $4) FROM s RETURNING staff_id, expires_at`,
    [email, name, hash, ENROLLMENT_TTL_MINUTES],
  );
  return { staffId: rows[0]!.staff_id, token, expiresAt: rows[0]!.expires_at };
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (the migration credential) is required; the console's own login cannot enroll staff");
  const email = arg(argv, "--email");
  const name = arg(argv, "--name");
  if (!email || !name) throw new Error("usage: enroll-staff --email <email> --name <name>");
  if (decodeURIComponent(new URL(url).username) === "ops_console") throw new Error("DATABASE_URL names the console login; use the migration credential");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const { token, expiresAt } = await enrollStaff(pool, { email, name });
    const origin = env.FX_OPS_ORIGIN ?? "https://<ops host>";
    process.stdout.write(`Enrollment link (shown once, valid until ${expiresAt.toISOString()}):\n${origin}/enroll?token=${token}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).catch((err: unknown) => {
    process.stderr.write(`enroll-staff: ${err instanceof Error ? err.message : "failed"}\n`);
    process.exitCode = 1;
  });
}
