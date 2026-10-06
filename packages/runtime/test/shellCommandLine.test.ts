import { describe, expect, it } from "vitest";
import { CREDENTIALED_URL_RE, commandIsClean, extractToolUses, shellCommandLine } from "../src/toolActivity.js";

// D#483 P4: a shell command's first line may travel on a tool use, but only when the WHOLE command is clean.
// SECURITY: these tests are the contract that a token, a credentialed URL or an env secret never leaves the runtime.
const ROOT = "/work/repo";
const use = (name: string, input: unknown, id = `t-${name}`) => ({ type: "tool_use", id, name, input });
const commandOf = (command: string) => extractToolUses([use("Bash", { command })], ROOT)[0] as unknown as Record<string, unknown>;

const TOKENS = [
  "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA",
  "sk-ant-api03-BBBBBBBBBBBBBBBBBBBB",
  "vck_CCCCCCCCCCCCCCCCCCCC",
  "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "github_pat_11AAAAAAA0AAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  // Built at runtime so no scanner-shaped token sits in the source.
  ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join("."),
];

describe("a shell command's first line", () => {
  it("keeps the first line, trimmed, for a plain command and a test run", () => {
    expect(commandOf("  git status --short  ")).toEqual({ id: "t-Bash", tool: "command", command: "git status --short" });
    expect(commandOf("pnpm vitest run packages/api")).toEqual({ id: "t-Bash", tool: "test", command: "pnpm vitest run packages/api" });
    expect(commandOf("ls\nrm -rf build")).toMatchObject({ command: "ls" });
    expect(commandOf("a\tb\u0007c")).toMatchObject({ command: "a b c" });
  });

  it("keeps no command for an empty line, a non-string, or a command over the raw limit", () => {
    expect(commandOf("   ")).toEqual({ id: "t-Bash", tool: "command" });
    expect(extractToolUses([use("Bash", { command: 5 })], ROOT)[0]).toEqual({ id: "t-Bash", tool: "command" });
    expect(commandOf("x ".repeat(3000))).toEqual({ id: "t-Bash", tool: "command" });
  });

  it("caps a long line at 200 characters at a word boundary and marks the cut", () => {
    const shown = commandOf(`echo ${"word ".repeat(80)}`).command as string;
    expect(shown.length).toBeLessThanOrEqual(200);
    expect(shown.endsWith("…")).toBe(true);
    expect(shown.startsWith("echo word word")).toBe(true);
    expect(commandOf("a".repeat(300))).toEqual({ id: "t-Bash", tool: "command" });
    expect(shellCommandLine("a".repeat(300))).toBeUndefined();
  });

  it("a token cut by the cap never leaves its first characters in the line", () => {
    const shown = shellCommandLine(`echo ${"x ".repeat(95)}sk-ant-oat01-AB`) ?? "";
    expect(shown).not.toContain("sk-ant");
  });

  it("never carries a token, a credentialed URL or an env secret: the kind survives, the text does not", () => {
    const secretCommands = [
      ...TOKENS.map((t) => `curl -H 'Authorization: Bearer ${t}' https://api.example.test`),
      ...TOKENS.map((t) => `echo ${t}`),
      "curl https://user:hunter2@example.test/x",
      "git push https://x-access-token:abc123@github.com/o/r.git",
      "psql postgres://app:s3cr3t@db.internal/app",
      ["ANTHROPIC_API_KEY=", "abcd1234efgh5678 node run.js"].join(""),
      "export DATABASE_PASSWORD=correct-horse-battery",
      "GITHUB_TOKEN=notarealtokenbutassigned gh api /user",
      "node run.js --password hunter2",
      ["deploy --api-key=", "abcd1234efgh5678"].join(""),
      ["curl", "-u", "admin:hunter2", "https://example.test"].join(" "),
      ["curl", "--user", "admin:hunter2", "https://example.test"].join(" "),
      ["curl", "--user=admin:hunter2", "https://example.test"].join(" "),
      ["curl", "-uadmin:hunter2", "https://example.test"].join(" "),
      "mysql -u root -phunter2 mydb",
      "mysql -u root -p hunter2 mydb",
      "mariadb -phunter2",
      "mysqldump -phunter2 db",
      "mysqladmin -u root -p hunter2 status",
      "docker login -u me -p hunter2",
      "docker login --password hunter2",
      "podman login -p hunter2 quay.io",
      "nerdctl login -p hunter2",
      "buildah login -p hunter2 quay.io",
      "helm registry login -p hunter2 ghcr.io",
      "echo x | docker login --password-stdin",
      "cat tok | docker login -u me --password-stdin ghcr.io",
      "sshpass -p hunter2 ssh host",
      "sshpass -phunter2 ssh host",
      "redis-cli -a hunter2 ping",
      "redis-cli -ahunter2 ping",
      "htpasswd -b .htpasswd me hunter2",
      "htpasswd -bc .htpasswd me hunter2",
      "aws configure set aws_secret_access_key hunter2",
      "npm config set //registry.npmjs.org/:_authToken hunter2",
      ["curl -H", "'Authorization: Basic YWRtaW46aHVudGVyMg=='", "https://example.test"].join(" "),
      "zip -P hunter2 out.zip dir",
      "unzip -P hunter2 file.zip",
      "zip -r -Phunter2 out.zip dir",
      "7z a -phunter2 out.7z dir",
      "7z a -p hunter2 out.7z dir",
      "7za x -phunter2 out.7z",
      "openssl enc -aes-256-cbc -in a -out b -k hunter2",
      "openssl enc -aes-256-cbc -in a -out b -pass pass:hunter2",
      "openssl rsa -in key.pem -passin pass:hunter2",
      "openssl pkcs12 -export -in c.pem -passout pass:hunter2 -out c.p12",
      "zip -rP hunter2 out.zip dir",
      "zip -9rP hunter2 out.zip dir",
      "unzip -oP hunter2 file.zip",
      "unzip -qqP hunter2 file.zip",
      "unzip -oPhunter2 file.zip",
      "zip --password hunter2 out.zip dir",
      "7z a -Phunter2 out.7z dir",
      "7z x -P hunter2 out.7z",
      "echo hunter2 | gh auth login --with-token",
      "gh auth login --with-token<tok",
      "gh auth login --with-token<<<hunter2",
      "cat tok | gh auth login --hostname github.com --with-token",
      "echo done # [redacted]",
      ["cat > .env <<'EOF'\nANTHROPIC_API_KEY=", "abcd1234efgh5678\nEOF"].join(""),
      "echo 'start\nsk-ant-oat01-AAAAAAAAAAAAAAAAAAAA'",
    ];
    for (const c of secretCommands) {
      const reduced = commandOf(c);
      expect(String(reduced.tool), c).toMatch(/^(command|test)$/);
      expect(reduced, c).not.toHaveProperty("command");
      const wire = JSON.stringify(reduced);
      for (const raw of ["sk-ant", "vck_", "ghp_", "ghs_", "github_pat", "eyJ", "hunter2", "s3cr3t", "abc123", "abcd1234", "correct-horse", "notarealtoken"]) {
        expect(wire, `${c} :: ${raw}`).not.toContain(raw);
      }
    }
  });

  it("keeps ordinary commands that use -p for something else, and the credential tools without a password flag", () => {
    for (const c of [
      "mkdir -p build/out",
      "ssh -p 22 host",
      "cp -p a b",
      "git add -p",
      "mysql -u root mydb",
      "docker ps -a",
      "docker run -p 8080:80 nginx",
      "docker login ghcr.io",
      "redis-cli ping",
      "ssh -p 2222 me@host ls",
      "git status --short",
      "zip -r out.zip dir",
      "unzip file.zip",
      "unzip -p file.zip README",
      "7z a out.7z dir",
      "openssl version",
      "openssl rand -hex 16",
      "gh pr view 1",
      "gh auth login",
      "gh auth status",
    ]) {
      expect(commandOf(c), c).toHaveProperty("command", c);
    }
  });

  it("names its checks", () => {
    expect(commandIsClean("git log --oneline -5")).toBe(true);
    expect(commandIsClean("curl https://example.test/path?x=1")).toBe(true);
    expect(commandIsClean("curl https://u:p@example.test")).toBe(false);
    expect(commandIsClean("curl https://token@example.test")).toBe(false);
    expect(commandIsClean("echo [redacted]")).toBe(false);
    expect(commandIsClean("npm ci --ignore-scripts --no-audit")).toBe(true);
    expect(commandIsClean("git diff --stat origin/main")).toBe(true);
    expect(CREDENTIALED_URL_RE.test("mail me@example.test")).toBe(false);
  });
});
