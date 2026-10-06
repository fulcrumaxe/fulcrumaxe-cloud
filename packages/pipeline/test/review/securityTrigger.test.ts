import { describe, expect, it } from "vitest";
import { SECURITY_TRIGGER_CODES, addedLines, pathWords, securityDiffTriggerFired, securityTriggers, type ChangedFile } from "../../src/review/securityTrigger.js";

/**
 * D#483 P3: the deterministic diff check that decides whether a pull request needs the security reviewer. A reviewed,
 * tested list: each surface the owner named has paths that fire it, lines that fire it, and look-alikes that do not.
 */
const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({ path, patch: "@@ -1 +1 @@\n+const harmless = 1;", changes: 1, ...over });
const codes = (...files: ChangedFile[]) => securityTriggers({ files });
const withLine = (line: string, path = "src/feature/thing.ts"): ChangedFile => file(path, { patch: `@@ -1,1 +1,2 @@\n context\n+${line}` });

describe("the surfaces, by path", () => {
  it.each([
    ["auth_sessions_tokens", ["src/auth/login.ts", "lib/session.ts", "app/api/oauth/callback/route.ts", "src/jwt.ts", "packages/api/src/tokens.ts", "src/signIn.ts", "server/csrfGuard.ts", "src/permissions.ts", "src/cookies.ts"]],
    ["crypto", ["src/crypto/hash.ts", "lib/encryption.ts", "src/hmac.ts", "src/tls.ts", "certs/server.pem", "src/kms.ts", "src/decryptPayload.ts"]],
    ["secrets_env", ["src/secrets.ts", ".env", ".env.production", "config/env.ts", "deploy/credentials.json", "id_rsa", "keys/server.key", ".npmrc", "src/vault/client.ts"]],
    ["dependency_manifest", ["package.json", "apps/web/package.json", "pnpm-lock.yaml", "yarn.lock", "requirements.txt", "requirements-dev.txt", "Cargo.toml", "go.sum", "Gemfile.lock", "pyproject.toml", "flake.lock", "poetry.lock", "pom.xml"]],
    ["ci_workflow", [".github/workflows/ci.yml", ".github/actions/setup/action.yml", ".gitlab-ci.yml", "Dockerfile", "docker/Dockerfile.api", "docker-compose.yml", ".circleci/config.yml", "Jenkinsfile", "CODEOWNERS", ".github/dependabot.yml"]],
    ["network_client", ["src/http/client.ts", "lib/fetchRetry.ts", "src/webhooks/deliver.ts", "src/proxy.ts", "src/websocket.ts", "lib/cors.ts", "src/netGuard.ts"]],
    ["sql_migrations", ["db/migrations/0001_init.sql", "packages/db/migrations/0710_x.sql", "src/queries/users.sql", "src/rls.ts", "prisma/schema.prisma"]],
    ["process_exec", ["scripts/deploy.sh", "src/exec.ts", "lib/spawnWorker.ts", "src/subprocess.py", "tools/run.ps1", "src/shell.ts"]],
    ["file_permissions", ["src/chmod.ts", "lib/umask.ts", "scripts/chown-data.ts"]],
    ["sandbox_proxy", ["packages/runner/src/sandboxPort.ts", "src/gh-proxy/handler.ts", "src/firewall.ts", "infra/sandbox-image/Dockerfile", "src/seccomp.ts"]],
  ] as const)("%s fires for a path that names it", (code, paths) => {
    for (const path of paths) expect(securityTriggers({ files: [{ path, patch: "@@\n+x", changes: 1 }] }), path).toContain(code);
  });

  it.each([
    "README.md",
    "docs/guide.md",
    "src/ui/Button.tsx",
    "src/components/Footer.tsx",
    "src/styles/theme.css",
    "src/utils/format.ts",
    "test/format.test.ts",
    "public/logo.png",
    "src/pages/about.tsx",
    "CHANGELOG.md",
    "src/i18n/en.json",
  ])("%s fires nothing", (path) => {
    expect(codes(file(path))).toEqual([]);
  });

  it("looks at a rename's previous path too", () => {
    expect(securityTriggers({ files: [{ path: "src/ui/plain.ts", previousPath: "src/auth/login.ts", patch: "@@\n+x", changes: 1 }] })).toContain("auth_sessions_tokens");
  });

  it("splits camelCase, snake_case and kebab-case into words and does not fire on a longer word that merely contains one", () => {
    expect(pathWords("src/lib/signInHandler_v2.test-utils.ts")).toEqual(["src", "lib", "sign", "in", "handler", "v2", "test", "utils", "ts"]);
    // 'authority', 'tokenizer' and 'envelope' are other words.
    expect(codes(file("src/authority.ts"))).toEqual([]);
    expect(codes(file("src/envelope.ts"))).toEqual([]);
    expect(codes(file("src/tokenizerLike.ts"))).toEqual([]);
  });
});

describe("the surfaces, by an added line", () => {
  it.each([
    ["process_exec", ["import { execSync } from 'node:child_process';", "const out = execSync('ls');", "spawn('node', args);", "subprocess.run(['ls'])", "os.system('rm -rf x')", "eval(userInput)", "new Function('a', body)"]],
    ["crypto", ["const h = createHash('sha256');", "randomBytes(16)", "import crypto from 'node:crypto';", "timingSafeEqual(a, b)", "crypto.subtle.digest('SHA-256', d)", "import hashlib"]],
    ["secrets_env", ["const key = process.env.API_KEY;", "os.environ['TOKEN']", "const apiKey = 'abc';", "password: hunter2", "client_secret = x", "import.meta.env.VITE_X"]],
    ["network_client", ["const r = await fetch(url);", "import axios from 'axios';", "new WebSocket(u)", "requests.get(url)", "http.request(opts, cb)", "import https from 'node:https';"]],
    ["sql_migrations", ["INSERT INTO users VALUES (1)", "ALTER TABLE t ADD COLUMN c int", "db.query(`select 1`)", "GRANT SELECT ON t TO app_user", "const q = sql`select * from t`", "UPDATE users SET name = 'x'", "SELECT id FROM users WHERE x = 1"]],
    ["file_permissions", ["fs.chmodSync(p, 0o600)", "await chmod(p, mode)", "{ path, mode: 0o444 }", "umask(0)"]],
    ["auth_sessions_tokens", ["headers.set('Authorization', t)", "res.setHeader('Set-Cookie', c)", "cookie: { httpOnly: true }", "verifyToken(t)", "const decoded = jwt.verify(t, k)"]],
    ["sandbox_proxy", ["const policy = networkPolicy(rules)", "--privileged", "setuid(0)"]],
  ] as const)("%s fires for a line that does it", (code, lines) => {
    for (const line of lines) expect(codes(withLine(line)), line).toContain(code);
  });

  it.each([
    "const total = items.length + 1;",
    "export const Button = () => <button>Save</button>;",
    "const m = /ab+c/.exec(text);",
    "regex.exec(line)",
    "element.focus();",
    "const title = 'Welcome back';",
    "console.log('saved');",
    "return value.trim().toLowerCase();",
    "// the session of the meeting list",
    "const fetchCount = 3;",
  ])("%j fires nothing", (line) => {
    expect(codes(withLine(line))).toEqual([]);
  });

  it("reads only ADDED lines: a removed line or a context line never fires", () => {
    const patch = "@@ -1,3 +1,3 @@\n-const h = createHash('sha256');\n context fetch(url)\n+const total = 1;";
    expect(codes(file("src/x.ts", { patch }))).toEqual([]);
    expect(addedLines(patch)).toBe("const total = 1;");
  });

  it("does not take the +++ file header for an added line", () => {
    expect(addedLines("--- a/x\n+++ b/exec(x)\n@@\n+ok")).toBe("ok");
  });

  it("a patch whose added lines run past the scan bound cannot be fully read: it fires diff_unavailable, even with the risky line past the bound", () => {
    const filler = "+const harmless = 1;\n".repeat(25_000); // over 400,000 characters of added lines
    const past = `@@\n${filler}+const h = createHash('sha256');`;
    expect(codes(file("src/big.ts", { patch: past }))).toEqual(["diff_unavailable"]);
    // just under the bound is read in full, so the risky line is found by its own rule
    const under = `@@\n${"+const harmless = 1;\n".repeat(100)}+const h = createHash('sha256');`;
    expect(codes(file("src/big.ts", { patch: under }))).toEqual(["crypto"]);
  });

  it("a huge harmless patch is answered quickly, and as unreadable (it is over the scan bound)", () => {
    const big = `@@\n${"+const harmless = 1;\n".repeat(100_000)}`;
    expect(codes(file("src/big.ts", { patch: big }))).toEqual(["diff_unavailable"]);
  });
});

describe("inputs it cannot judge fire it", () => {
  it("a changed file whose patch GitHub left out (a diff too large to show) fires diff_unavailable", () => {
    expect(codes({ path: "src/huge.ts", patch: null, changes: 4000 })).toEqual(["diff_unavailable"]);
    expect(codes({ path: "src/huge.ts", changes: 4000 })).toEqual(["diff_unavailable"]);
  });
  it("a binary file or an empty change, which has no patch and no changed lines, does not", () => {
    expect(codes({ path: "public/logo.png", patch: null, changes: 0 })).toEqual([]);
    expect(codes({ path: "public/logo.png" })).toEqual([]);
  });
  it("a file list the caller could not read to the end fires files_truncated", () => {
    expect(securityTriggers({ files: [], truncated: true })).toEqual(["files_truncated"]);
    expect(securityDiffTriggerFired({ files: [file("README.md")], truncated: true })).toBe(true);
  });
  it("no files at all fires nothing", () => {
    expect(securityTriggers({ files: [] })).toEqual([]);
    expect(securityDiffTriggerFired({ files: [] })).toBe(false);
  });
  it("a malformed entry is skipped, not trusted and not fatal", () => {
    expect(securityTriggers({ files: [{ path: 7 as unknown as string }, file("README.md")] })).toEqual([]);
  });
});

describe("the answer", () => {
  it("is every code that applies, once, in the table's order", () => {
    const out = codes(file("src/auth/login.ts"), file("package.json"), withLine("fetch(u)", "src/a.ts"), file(".github/workflows/ci.yml"));
    expect(out).toEqual(["auth_sessions_tokens", "dependency_manifest", "ci_workflow", "network_client"]);
    expect(new Set(out).size).toBe(out.length);
    for (const c of out) expect(SECURITY_TRIGGER_CODES).toContain(c);
  });
  it("is deterministic: the same files give the same answer", () => {
    const files = [file("src/auth/login.ts"), withLine("process.env.X")];
    expect(securityTriggers({ files })).toEqual(securityTriggers({ files: [...files].reverse() }));
  });
  it("every code is a plain code a driver event can carry", () => {
    for (const c of SECURITY_TRIGGER_CODES) expect(c).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });
  it("each surface the owner named has at least one rule: nothing was dropped from the list", () => {
    expect([...SECURITY_TRIGGER_CODES].filter((c) => c !== "diff_unavailable" && c !== "files_truncated").sort()).toEqual(
      ["auth_sessions_tokens", "ci_workflow", "crypto", "dependency_manifest", "file_permissions", "network_client", "process_exec", "sandbox_proxy", "secrets_env", "sql_migrations"].sort(),
    );
  });
});
