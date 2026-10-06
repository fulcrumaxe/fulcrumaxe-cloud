/**
 * D#483 P3: when a pull request needs a security review beyond the code reviewer's. Deterministic: the same files give
 * the same answer, with no model and no network. The owner approved this rule: run the security reviewer when the item is
 * critical, when the diff touches one of the surfaces below, or when the code reviewer says it is needed (the last two
 * live in `requiredReviewRoles`; this file is the diff check).
 *
 * The check reads the changed files' PATHS and the ADDED lines of their patches, and nothing else. A path or a line is
 * data to match, never an instruction. Each rule has a fixed code, so the reason a review was required can be recorded
 * and shown without any text from the diff.
 *
 * Surfaces: auth / sessions / tokens, crypto, secrets and environment handling, dependency manifests and lockfiles, CI
 * workflows and build images, network / HTTP clients, SQL and migrations, shell and process execution, file permissions,
 * and sandbox / proxy code.
 *
 * It errs toward running the review: a false positive costs one review run, a miss lets a risky change merge with one
 * reviewer less. Two inputs it cannot judge also fire it: a changed file whose patch GitHub left out (too large to
 * show), and a file list the caller could not read to the end.
 */

export const SECURITY_TRIGGER_CODES = [
  'auth_sessions_tokens',
  'crypto',
  'secrets_env',
  'dependency_manifest',
  'ci_workflow',
  'network_client',
  'sql_migrations',
  'process_exec',
  'file_permissions',
  'sandbox_proxy',
  'diff_unavailable',
  'files_truncated',
] as const;
export type SecurityTriggerCode = (typeof SECURITY_TRIGGER_CODES)[number];

/** One changed file of a pull request, as GitHub reports it (only these fields are read). */
export interface ChangedFile {
  path: string;
  /** The file's previous path when it was renamed. */
  previousPath?: string | null;
  /** The unified diff of the file; GitHub omits it for a binary file and for a diff it will not show. */
  patch?: string | null;
  /** Lines added plus lines removed, as GitHub counts them. */
  changes?: number;
}

/** The words of a path, lower-cased: split on anything that is not a letter or digit and on camelCase boundaries. */
export function pathWords(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

const WORDS = (...w: string[]): ReadonlySet<string> => new Set(w);

const AUTH_WORDS = WORDS('auth', 'authn', 'authz', 'authentication', 'authorization', 'authorize', 'session', 'sessions', 'oauth', 'oidc', 'jwt', 'token', 'tokens', 'login', 'logout', 'signin', 'signout', 'signup', 'password', 'passwords', 'passwd', 'credential', 'credentials', 'cookie', 'cookies', 'csrf', 'saml', 'sso', 'passport', 'rbac', 'acl', 'permission', 'permissions', 'apikey', 'mfa', 'totp');
const CRYPTO_WORDS = WORDS('crypto', 'cipher', 'encrypt', 'encryption', 'decrypt', 'decryption', 'hmac', 'signature', 'signatures', 'tls', 'ssl', 'cert', 'certs', 'certificate', 'certificates', 'pem', 'x509', 'bcrypt', 'argon2', 'scrypt', 'pbkdf2', 'kms', 'nonce', 'keystore', 'sealed', 'sealing');
const SECRET_WORDS = WORDS('secret', 'secrets', 'vault', 'dotenv', 'env', 'envs', 'privatekey', 'credentials');
const NETWORK_WORDS = WORDS('http', 'https', 'httpclient', 'fetch', 'axios', 'webhook', 'webhooks', 'proxy', 'websocket', 'websockets', 'socket', 'sockets', 'grpc', 'cors', 'ssrf', 'egress', 'ingress', 'netguard');
const EXEC_WORDS = WORDS('exec', 'execa', 'spawn', 'subprocess', 'shell', 'shellout', 'cmd');
const PERMISSION_WORDS = WORDS('chmod', 'chown', 'umask', 'chgrp');
const SANDBOX_WORDS = WORDS('sandbox', 'sandboxes', 'jail', 'firewall', 'seccomp', 'apparmor', 'netpolicy', 'ghproxy');
const SQL_WORDS = WORDS('migration', 'migrations', 'sql', 'rls', 'postgres', 'pg');

const DEPENDENCY_FILES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', '.yarnrc', '.yarnrc.yml', '.npmrc', 'bun.lock', 'bun.lockb', 'deno.json', 'deno.lock',
  'pyproject.toml', 'poetry.lock', 'pipfile', 'pipfile.lock', 'uv.lock', 'setup.py', 'setup.cfg', 'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pom.xml', 'mix.exs', 'mix.lock', 'podfile', 'podfile.lock', 'package.swift', 'flake.lock', 'flake.nix', 'shell.nix', 'default.nix', 'renovate.json',
]);

/** Paths matched as a whole (not by word). */
const PATH_RULES: ReadonlyArray<{ code: SecurityTriggerCode; test: (path: string, base: string) => boolean }> = [
  { code: 'dependency_manifest', test: (_p, base) => DEPENDENCY_FILES.has(base) || /^requirements[\w.-]*\.(txt|in)$/.test(base) || /\.csproj$/.test(base) },
  {
    code: 'ci_workflow',
    test: (p, base) =>
      /^\.github\/(workflows|actions)\//.test(p) ||
      /^\.github\/(dependabot|codeowners)/.test(p) ||
      /^\.(circleci|buildkite|gitlab)\//.test(p) ||
      /^(\.gitlab-ci\.yml|\.travis\.yml|jenkinsfile|azure-pipelines\.yml|bitbucket-pipelines\.yml|codeowners)$/.test(base) ||
      /^dockerfile/.test(base) ||
      /\.dockerfile$/.test(base) ||
      /^(docker-)?compose[\w.-]*\.ya?ml$/.test(base) ||
      /^(vercel|netlify)\.(json|toml)$/.test(base),
  },
  { code: 'secrets_env', test: (_p, base) => /^\.env(\..*)?$/.test(base) || /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/.test(base) || /^(\.netrc|\.npmrc|\.yarnrc|\.yarnrc\.yml|\.pgpass|id_rsa|id_ed25519|credentials\.json|service-account[\w.-]*\.json)$/.test(base) },
  { code: 'sql_migrations', test: (p, base) => /\.sql$/.test(base) || /(^|\/)(migrations?|prisma|drizzle)\//.test(p) },
  { code: 'process_exec', test: (_p, base) => /\.(sh|bash|zsh|ps1|bat|cmd)$/.test(base) },
];

/** A word list also matches two neighbouring words joined (`sign` `in` -> `signin`, `gh` `proxy` -> `ghproxy`). */
const withPairs = (words: readonly string[]): string[] => [...words, ...words.slice(1).map((w, i) => `${words[i]}${w}`)];
const hasAny = (words: readonly string[], set: ReadonlySet<string>): boolean => withPairs(words).some((w) => set.has(w));

/** Rules on the added lines of a patch. Each is anchored to a call, an import or an assignment, not to a bare word. */
const CONTENT_RULES: ReadonlyArray<{ code: SecurityTriggerCode; test: RegExp }> = [
  { code: 'process_exec', test: /\bchild_process\b|(?<![.\w$])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(|\bsubprocess\.|\bos\.system\b|\bPopen\b|\bProcessBuilder\b|\bRuntime\.getRuntime\(\)\.exec\b|(?<![.\w$])eval\s*\(|\bnew Function\s*\(/ },
  { code: 'crypto', test: /\bcreate(?:Hash|Hmac|Cipheriv|Decipheriv|Sign|Verify)\b|\brandomBytes\b|\brandomUUID\b|\btimingSafeEqual\b|\bcrypto\.subtle\b|\bgenerateKeyPair(?:Sync)?\b|\bpbkdf2(?:Sync)?\b|\bscrypt(?:Sync)?\b|\bbcrypt\b|\bargon2\b|\bhashlib\b|\bhmac\.new\b|\bFernet\b|from\s+["'](?:node:)?crypto["']|require\(\s*["'](?:node:)?crypto["']\s*\)|\bjsonwebtoken\b|from\s+["']jose["']/ },
  { code: 'secrets_env', test: /\bprocess\.env\b|\bos\.environ\b|\bos\.getenv\b|\bSystem\.getenv\b|\bDeno\.env\b|\bimport\.meta\.env\b|\bENV\[|(?<![.\w$])getenv\s*\(|\b(?:api[_-]?key|secret|passw(?:or)?d|private[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]/i },
  { code: 'network_client', test: /(?<![.\w$])fetch\s*\(|\baxios\b|\bXMLHttpRequest\b|\bhttps?\.(?:request|get)\s*\(|from\s+["'](?:node:)?https?["']|require\(\s*["'](?:node:)?https?["']\s*\)|\bnew WebSocket\b|\brequests\.(?:get|post|put|delete|patch|request)\s*\(|\burllib\b|\bhttpx\b|\bnet\.(?:connect|createConnection)\s*\(|\bundici\b|\bhttp\.Client\b|\bcurl\s+-/ },
  { code: 'sql_migrations', test: /\bINSERT\s+INTO\b|\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b|\bCREATE\s+(?:TABLE|POLICY|FUNCTION|INDEX)\b|\bALTER\s+TABLE\b|\bDROP\s+TABLE\b|\bGRANT\s+\w|\bREVOKE\s+\w|\bSELECT\s.+\sFROM\s|\$queryRaw|\bsql\s*`|\.query\s*\(\s*[`"']/i },
  { code: 'file_permissions', test: /\b(?:chmod|chown|chgrp|umask|fchmod|setfacl)(?:Sync)?\b|\bmode\s*:\s*0o[0-7]{3,4}\b/ },
  { code: 'auth_sessions_tokens', test: /["']authorization["']|\bBearer\s|\bset-cookie\b|\bhttpOnly\b|\bsameSite\b|\bverify(?:Token|Jwt|Session)\b|\bsign(?:In|Out)\s*\(|\bcheckPermission\b|\bjwt\b/i },
  { code: 'sandbox_proxy', test: /\bseccomp\b|\bapparmor\b|\bchroot\b|\bunshare\b|\bsetuid\b|\bsetgid\b|--privileged\b|\bnetworkPolicy\b|\bgh-proxy\b/i },
];

/** The added lines of a unified diff, joined by newlines (the `+++` file header excluded). */
export function addedLines(patch: string): string {
  const out: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) out.push(line.slice(1));
  }
  return out.join('\n');
}

/** Bound on the text a content rule scans per file: a larger added block is scanned in its first part only. */
const MAX_SCAN_CHARS = 400_000;

function codesForPath(path: string): Set<SecurityTriggerCode> {
  const found = new Set<SecurityTriggerCode>();
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  const words = pathWords(path);
  for (const rule of PATH_RULES) if (rule.test(lower, base)) found.add(rule.code);
  if (hasAny(words, AUTH_WORDS)) found.add('auth_sessions_tokens');
  if (hasAny(words, CRYPTO_WORDS)) found.add('crypto');
  if (hasAny(words, SECRET_WORDS)) found.add('secrets_env');
  if (hasAny(words, NETWORK_WORDS)) found.add('network_client');
  if (hasAny(words, EXEC_WORDS)) found.add('process_exec');
  if (hasAny(words, PERMISSION_WORDS)) found.add('file_permissions');
  if (hasAny(words, SANDBOX_WORDS)) found.add('sandbox_proxy');
  if (hasAny(words, SQL_WORDS)) found.add('sql_migrations');
  return found;
}

export interface SecurityTriggerInput {
  files: readonly ChangedFile[];
  /** True when the caller could not read the whole file list (a very large pull request). */
  truncated?: boolean;
}

/** The codes of every surface this pull request touches, in the order of SECURITY_TRIGGER_CODES. Empty means none. */
export function securityTriggers(input: SecurityTriggerInput): SecurityTriggerCode[] {
  const found = new Set<SecurityTriggerCode>();
  if (input.truncated === true) found.add('files_truncated');
  for (const f of input.files) {
    if (typeof f.path !== 'string') continue;
    for (const c of codesForPath(f.path)) found.add(c);
    if (typeof f.previousPath === 'string') for (const c of codesForPath(f.previousPath)) found.add(c);
    if (typeof f.patch === 'string') {
      const added = addedLines(f.patch);
      const text = added.slice(0, MAX_SCAN_CHARS);
      // Added lines past the scan bound are not read: a diff this large cannot be judged, so it is reviewed.
      if (added.length > MAX_SCAN_CHARS) found.add('diff_unavailable');
      for (const rule of CONTENT_RULES) if (!found.has(rule.code) && rule.test.test(text)) found.add(rule.code);
    } else if (typeof f.changes === 'number' && f.changes > 0) {
      // GitHub shows no patch for a diff it considers too large: it cannot be judged, so it is reviewed.
      found.add('diff_unavailable');
    }
  }
  return SECURITY_TRIGGER_CODES.filter((c) => found.has(c));
}

/** True when the diff check fires. The merge gate's `securityDiffTriggerFired` input. */
export function securityDiffTriggerFired(input: SecurityTriggerInput): boolean {
  return securityTriggers(input).length > 0;
}
