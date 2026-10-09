import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MIN_CLAUDE_VERSION } from "../../src/engines/claude/pin.js";
import { MACOS_PREVIEW_NOTICE, WINDOWS_UNSUPPORTED_NOTICE } from "../../src/platformSupport.js";
import { INSTALL_COMMAND, NIXOS_CONFIG_LINE } from "../../src/sandbox/sandboxFix.js";
import { findOnPath } from "../helpers/findOnPath.js";
import { generateSelfSignedCert } from "../helpers/selfSignedCert.js";

// D#6 R6-4: install.sh run by real shells (bash and dash) against a real local HTTPS server, with the real curl and a real
// sha256 tool. Fakes (sudo, package managers, claude, uname, id) sit first on a PATH that holds only the tools the script needs,
// and every case that depends on a fake also proves the fake ran. Fixtures only: the artifact is a tiny script, the certificate
// is generated in memory for each run, and nothing leaves 127.0.0.1.
const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INSTALL_SH = path.join(PKG, "install.sh");
const README = readFileSync(path.join(PKG, "README.md"), "utf8");
const SCRIPT_TEXT = readFileSync(INSTALL_SH, "utf8");
const HOST_PATH = process.env.PATH ?? "";
const STRICT = (process.env.CI ?? "") !== ""; // on CI a missing tool is a failure, elsewhere the cases that need it skip

const BASH = findOnPath("bash", HOST_PATH);
const DASH = findOnPath("dash", HOST_PATH);
const SHELLCHECK = findOnPath("shellcheck", HOST_PATH);
const PYTHON = findOnPath("python3", HOST_PATH);
const REAL_CURL = findOnPath("curl", HOST_PATH);
const SHA256SUM = findOnPath("sha256sum", HOST_PATH);
const SHASUM = findOnPath("shasum", HOST_PATH);
const BASE_TOOLS = ["grep", "sed", "tr", "cut", "head", "mktemp", "mkdir", "rmdir", "rm", "mv", "ln", "chmod", "cat"] as const;

type Platform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";
const PLATFORMS: Platform[] = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const VERSION = "0.1.0";
const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** The fixture fx-runner: `--version`, and `doctor --sandbox-only` that logs and exits as FX_FIXTURE_PROBE says. */
function artifactFor(platform: string, versionExit = 0): string {
  return `#!/bin/sh
# fixture ${platform}
echo "$1 NODE_OPTIONS=\${NODE_OPTIONS-unset} NODE_PATH=\${NODE_PATH-unset}" >> "$FX_TEST_LOG_DIR/env.log"
if [ -n "\${FX_TEST_READ_STDIN:-}" ]; then cat > "$FX_TEST_LOG_DIR/stdin-$1.log"; fi
case "$1" in
  --version) echo "fx-runner ${VERSION} (fixture)"; exit ${versionExit} ;;
  doctor)
    echo "$*" >> "$FX_TEST_LOG_DIR/doctor.log"
    if [ "\${FX_FIXTURE_PROBE:-0}" != 0 ]; then echo "sandbox: bubblewrap cannot create a user namespace (fixture)" >&2; exit 1; fi
    exit 0 ;;
esac
exit 64
`;
}

function render(over: { version?: string; sha?: Partial<Record<Platform, string>>; text?: string } = {}): string {
  let text = over.text ?? SCRIPT_TEXT;
  text = text.replace("@FX_VERSION@", over.version ?? VERSION);
  for (const p of PLATFORMS) text = text.replace(`@FX_SHA256_${p.toUpperCase().replace("-", "_")}@`, over.sha?.[p] ?? sha(artifactFor(p)));
  return text;
}

interface Fixture {
  home: string;
  tools: string;
  logs: string;
  script: string;
  env: Record<string, string>;
}
const dirs: string[] = [];
let server: https.Server;
let baseUrl = "";
let cert = "";
let certDir = "";
const served = new Map<string, Buffer>(); // "/v0.1.0/fx-runner-linux-x64" -> bytes
let requests: string[] = [];
let redirectToHttp = false;

beforeAll(async () => {
  const generated = generateSelfSignedCert("127.0.0.1", 1, { ipAddresses: ["127.0.0.1"] });
  certDir = mkdtempSync(path.join(tmpdir(), "fxr64-cert-"));
  cert = path.join(certDir, "ca.pem");
  writeFileSync(cert, generated.certPem);
  server = https.createServer({ key: generated.keyPem, cert: generated.certPem }, (req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    // GitHub answers a release download with a redirect to another host; the fixture redirects to its own /objects path.
    if (url.startsWith("/objects/")) {
      const body = served.get(url.slice("/objects".length));
      if (body === undefined) return void res.writeHead(404).end();
      return void res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length }).end(body);
    }
    if (!served.has(url)) return void res.writeHead(404).end();
    const origin = redirectToHttp ? `http://127.0.0.1:${(server.address() as AddressInfo).port}` : "";
    res.writeHead(302, { location: `${origin}/objects${url}` }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(certDir, { recursive: true, force: true });
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  served.clear();
  requests = [];
  redirectToHttp = false;
});

function script(name: string, body: string): string {
  return `#!/bin/sh\n${body}\n`;
}

interface Options {
  checksum?: "sha256sum" | "shasum";
  claude?: string | null; // the version line the fake prints; null = no claude on PATH
  withDeps?: boolean; // fake bwrap and socat on PATH
  uname?: [string, string];
  osRelease?: string;
  nixos?: boolean;
  uid?: number;
  procVersion?: string;
  arm64Mac?: boolean;
  env?: Record<string, string>;
}
function fixture(options: Options = {}): Fixture {
  if (!existsSync(cert)) throw new Error("certificate missing");
  const root = mkdtempSync(path.join(tmpdir(), "fxr64-"));
  dirs.push(root);
  const tools = path.join(root, "tools");
  const logs = path.join(root, "logs");
  const home = path.join(root, "home");
  for (const d of [tools, logs, home]) mkdirSync(d);
  for (const name of BASE_TOOLS) {
    const real = findOnPath(name, HOST_PATH);
    if (real === undefined) throw new Error(`tool ${name} not found on the host`);
    symlinkSync(real, path.join(tools, name));
  }
  const checksum = options.checksum ?? "sha256sum";
  const realSum = checksum === "sha256sum" ? SHA256SUM : SHASUM;
  if (realSum === undefined) throw new Error(`${checksum} not found on the host`);
  symlinkSync(realSum, path.join(tools, checksum));
  // curl is a wrapper that records its arguments and then runs the real curl, so the flags the script uses are proven, not assumed
  writeFileSync(path.join(tools, "curl"), script("curl", `echo "$*" >> "$FX_TEST_LOG_DIR/curl.log"\nexec ${REAL_CURL ?? "curl"} "$@"`), { mode: 0o755 });
  writeFileSync(path.join(tools, "uname"), script("uname", `case "$1" in -m) echo "$FX_TEST_UNAME_M" ;; *) echo "$FX_TEST_UNAME_S" ;; esac`), { mode: 0o755 });
  writeFileSync(path.join(tools, "id"), script("id", `[ "$1" = -u ] && echo "$FX_TEST_UID"`), { mode: 0o755 });
  writeFileSync(path.join(tools, "sudo"), script("sudo", `echo "$*" >> "$FX_TEST_LOG_DIR/sudo.log"\nexec "$@"`), { mode: 0o755 });
  for (const manager of ["apt-get", "dnf", "pacman"]) writeFileSync(path.join(tools, manager), script(manager, `echo "$*" >> "$FX_TEST_LOG_DIR/${manager}.log"\nif [ -n "\${FX_TEST_READ_STDIN:-}" ]; then read -r line; echo "$line" > "$FX_TEST_LOG_DIR/${manager}-stdin.log"; fi`), { mode: 0o755 });
  if (options.withDeps === true) for (const dep of ["bwrap", "socat"]) writeFileSync(path.join(tools, dep), script(dep, "exit 0"), { mode: 0o755 });
  if (options.claude !== null)
    writeFileSync(path.join(tools, "claude"), script("claude", `echo "x" >> "$FX_TEST_LOG_DIR/claude.log"\nif [ -n "\${FX_TEST_READ_STDIN:-}" ]; then cat > "$FX_TEST_LOG_DIR/stdin-claude.log"; fi\necho '${options.claude ?? `${MIN_CLAUDE_VERSION} (Claude Code)`}'`), { mode: 0o755 });
  if (options.arm64Mac !== undefined) writeFileSync(path.join(tools, "sysctl"), script("sysctl", `echo ${options.arm64Mac ? 1 : 0}`), { mode: 0o755 });
  const osRelease = path.join(root, "os-release");
  writeFileSync(osRelease, options.osRelease ?? "ID=debian\n");
  const procVersion = path.join(root, "proc-version");
  writeFileSync(procVersion, options.procVersion ?? "Linux version 6.1.0 (builder@host) (gcc)\n");
  const marker = path.join(root, options.nixos === true ? "NIXOS" : "no-such-marker");
  if (options.nixos === true) writeFileSync(marker, "");
  const scriptPath = path.join(root, "install.sh");
  writeFileSync(scriptPath, render());
  const env: Record<string, string> = {
    PATH: tools,
    HOME: home,
    CURL_CA_BUNDLE: cert,
    FX_FORBID_MODEL_CALLS: "1",
    FX_INSTALL_BASE_URL: baseUrl,
    FX_INSTALL_OS_RELEASE_FILE: osRelease,
    FX_INSTALL_PROC_VERSION_FILE: procVersion,
    FX_INSTALL_NIXOS_MARKER: marker,
    FX_TEST_LOG_DIR: logs,
    FX_TEST_UNAME_S: options.uname?.[0] ?? "Linux",
    FX_TEST_UNAME_M: options.uname?.[1] ?? "x86_64",
    FX_TEST_UID: String(options.uid ?? 1000),
    ...options.env,
  };
  return { home, tools, logs, script: scriptPath, env };
}

function serveAll(version = VERSION): void {
  for (const p of PLATFORMS) served.set(`/v${version}/fx-runner-${p}`, Buffer.from(artifactFor(p)));
}
const log = (f: Fixture, name: string): string[] => {
  const file = path.join(f.logs, `${name}.log`);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l !== "") : [];
};

interface Result {
  code: number | null;
  out: string; // stdout, then stderr (a pty merges them)
  stdout: string;
  stderr: string;
}
/** Runs the script in its own session (no controlling terminal), stdin closed: the non-interactive case. */
function run(f: Fixture, shell: string, args: string[] = [], over?: Fixture["env"]): Promise<Result> {
  return spawnIt(shell, [f.script, ...args], { ...f.env, ...over });
}
/** Runs it under a real pseudo-terminal that has `answer` typed ahead, to test the prompt. */
function runTty(f: Fixture, shell: string, answer: string, args: string[] = [], over?: Fixture["env"]): Promise<Result> {
  const py = `
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    if os.environ.get("FX_TEST_PIPE_SCRIPT"):
        # the script arrives on a pipe, as with cat install.sh | sh, with a tail the script itself never reads
        r, w = os.pipe()
        if os.fork() == 0:
            os.close(r)
            with open(sys.argv[2], "rb") as f:
                os.write(w, f.read() + b"SECRET-TAIL\\n")
            os._exit(0)
        os.close(w)
        os.dup2(r, 0)
        os.close(r)
        os.execv(sys.argv[1], [sys.argv[1], "-s", "--"] + sys.argv[3:])
    os.execv(sys.argv[1], sys.argv[1:])
os.write(fd, os.environ["FX_TEST_ANSWER"].encode() + b"\\n")
out = b""
while True:
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    out += data
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(status))
`;
  return spawnIt(PYTHON ?? "python3", ["-I", "-c", py, shell, f.script, ...args], { ...f.env, ...over, FX_TEST_ANSWER: answer, PATH: `${f.env.PATH}:${path.dirname(PYTHON ?? "/")}` });
}
/** Runs `shell` with `text` (the script) piped to its stdin, as `cat install.sh | sh` does; `args` follow `-s --`. */
function runPiped(f: Fixture, shell: string, text: string, args: string[] = [], over?: Fixture["env"]): Promise<Result> {
  return spawnIt(shell, ["-s", "--", ...args], { ...f.env, ...over }, text);
}
function spawnIt(file: string, args: string[], env: Record<string, string>, stdin?: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, detached: true, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (stdin !== undefined) {
      child.stdin?.on("error", () => undefined); // the shell may exit before it has read everything
      child.stdin?.end(stdin);
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
  });
}
const installed = (f: Fixture, v = VERSION): string => path.join(f.home, ".fx-runner", "versions", v, "fx-runner");
const link = (f: Fixture): string => path.join(f.home, ".fx-runner", "bin", "fx-runner");
const nothingInstalled = (f: Fixture): void => {
  const state = path.join(f.home, ".fx-runner");
  expect(existsSync(path.join(state, "versions"))).toBe(false);
  expect(existsSync(path.join(state, "bin"))).toBe(false);
  expect(existsSync(state) ? readdirSync(state) : []).toEqual([]); // not even a staging directory is left behind
};
const T = 30_000;
/** Every path under `dir` with its type (a symlink with its target, a file with its content), without following links. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const full = path.join(dir, rel);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) return void out.push(`${rel} -> ${readlinkSync(full)}`);
    if (st.isDirectory()) {
      out.push(`${rel}/`);
      for (const name of readdirSync(full).sort()) walk(path.join(rel, name));
      return;
    }
    out.push(`${rel} ${readFileSync(full, "utf8")}`);
  };
  walk("");
  return out;
}
function symlinkTo(target: string, linkPath: string): string {
  symlinkSync(target, linkPath);
  return linkPath;
}

describe("install.sh tools", () => {
  it("the shells and checkers the other cases need are present (a failure on CI, a skip elsewhere)", () => {
    const missing = Object.entries({ bash: BASH, dash: DASH, shellcheck: SHELLCHECK, python3: PYTHON, curl: REAL_CURL, sha256sum: SHA256SUM, shasum: SHASUM }).filter(([, v]) => v === undefined).map(([k]) => k);
    if (STRICT) expect(missing).toEqual([]);
    else if (missing.length > 0) console.warn(`install.sh tests skip cases that need: ${missing.join(", ")}`);
  });
});

describe("install.sh static checks", () => {
  it.skipIf(SHELLCHECK === undefined)("shellcheck passes in sh mode", () => {
    execFileSync(SHELLCHECK ?? "shellcheck", ["-s", "sh", INSTALL_SH]);
  });
  it("starts with a POSIX sh shebang, is executable, and parses in bash --posix and dash", () => {
    expect(SCRIPT_TEXT.startsWith("#!/bin/sh\n")).toBe(true);
    expect(statSync(INSTALL_SH).mode & 0o111).not.toBe(0);
    if (BASH !== undefined) execFileSync(BASH, ["--posix", "-n", INSTALL_SH]);
    if (DASH !== undefined) execFileSync(DASH, ["-n", INSTALL_SH]);
  });
  it("uses sudo only in the confirmed dependency branch, and pipes nothing to a shell except the Claude line it prints", () => {
    const sudoLines = SCRIPT_TEXT.split("\n").filter((l) => /\bsudo\b/.test(l) && !l.trimStart().startsWith("#"));
    expect(sudoLines.filter((l) => /^\s*sudo \$pkg/.test(l))).toHaveLength(1);
    expect(SCRIPT_TEXT.split("\n").filter((l) => !l.trimStart().startsWith("#") && /\|\s*(ba|z|da)?sh\b/.test(l))).toEqual(['CLAUDE_INSTALL_LINE="curl -fsSL https://claude.ai/install.sh | bash"']);
    expect(SCRIPT_TEXT).not.toMatch(/\beval\b/);
  });
  it("keeps the whole body in main(), called on the last line", () => {
    const lines = SCRIPT_TEXT.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.at(-2)).toBe('main "$@"');
    expect(lines.filter((l) => l === "main() {")).toHaveLength(1);
    expect(lines.filter((l) => /^main\b/.test(l))).toEqual(["main() {", 'main "$@"']);
  });
  it("names the same release files as release-manifest.mjs --names", () => {
    const block = /FX_ARTIFACT_NAMES="([^"]+)"/.exec(SCRIPT_TEXT)?.[1];
    const names = execFileSync(process.execPath, [path.join(PKG, "scripts", "release-manifest.mjs"), "--names"], { encoding: "utf8" });
    expect(block).toBeDefined();
    expect(`${block}\n`).toBe(names);
  });
  it("carries the same constants as the runner: MIN_CLAUDE_VERSION, the Windows and macOS sentences (and the README's), the install commands", () => {
    const value = (name: string): string | undefined => new RegExp(`^${name}="([^"]*)"$`, "m").exec(SCRIPT_TEXT)?.[1];
    expect(value("MIN_CLAUDE_VERSION")).toBe(MIN_CLAUDE_VERSION);
    expect(value("WINDOWS_UNSUPPORTED_NOTICE")).toBe(WINDOWS_UNSUPPORTED_NOTICE);
    expect(value("MACOS_PREVIEW_NOTICE")).toBe(MACOS_PREVIEW_NOTICE);
    expect(README).toContain(WINDOWS_UNSUPPORTED_NOTICE);
    expect(README).toContain(MACOS_PREVIEW_NOTICE);
    expect(`sudo ${value("PKG_APT")}`).toBe(INSTALL_COMMAND.debian);
    expect(`sudo ${value("PKG_DNF")}`).toBe(INSTALL_COMMAND.fedora);
    expect(`sudo ${value("PKG_PACMAN")}`).toBe(INSTALL_COMMAND.arch);
    expect(value("NIXOS_CONFIG_LINE")).toBe(NIXOS_CONFIG_LINE);
  });
});

const shells = [
  ["bash", BASH],
  ["dash", DASH],
] as const;
describe.each(shells)("install.sh under %s", (shellName, shellPath) => {
  const d = describe.skipIf(shellPath === undefined);
  const sh = shellPath ?? "";
  d("install", () => {
    it("installs the Linux x64 file from a real HTTPS server, links it, and finishes with the next step (exit 0)", async () => {
      serveAll();
      const f = fixture({ withDeps: true });
      const r = await run(f, sh);
      expect(r.code, r.out).toBe(0);
      expect(readFileSync(installed(f), "utf8")).toBe(artifactFor("linux-x64"));
      expect(statSync(installed(f)).mode & 0o777).toBe(0o755);
      expect(readlinkSync(link(f))).toBe(`../versions/${VERSION}/fx-runner`);
      expect(statSync(path.join(f.home, ".fx-runner")).mode & 0o777).toBe(0o700);
      expect(r.stdout).toContain("Next: fx-runner register --code <code> --credential-mode <subscription|api_key> --cloud-url <url>");
      // the real curl flags were used, one request to the release path followed the redirect, and nothing else was fetched
      const curl = log(f, "curl");
      expect(curl).toHaveLength(1);
      expect(curl[0]).toMatch(/--proto =https --proto-redir =https --tlsv1\.2 -fsSL -o \S+ https:\/\/127\.0\.0\.1:\d+\/v0\.1\.0\/fx-runner-linux-x64$/);
      expect(requests).toEqual(["/v0.1.0/fx-runner-linux-x64", "/objects/v0.1.0/fx-runner-linux-x64"]);
      expect(log(f, "doctor")).toEqual(["doctor --sandbox-only"]);
      expect(log(f, "sudo")).toEqual([]);
      expect(r.out).not.toContain("claude.ai/install.sh");
    }, T);

    it.each([["sha256sum" as const], ["shasum" as const]])("checks the download with %s", async (checksum) => {
      if ((checksum === "shasum" ? SHASUM : SHA256SUM) === undefined) return;
      serveAll();
      const f = fixture({ withDeps: true, checksum });
      expect((await run(f, sh)).code).toBe(0);
      expect(existsSync(installed(f))).toBe(true);
    }, T);

    it("a tampered download exits 1, installs nothing and leaves no staging directory", async () => {
      serveAll();
      served.set("/v0.1.0/fx-runner-linux-x64", Buffer.from(`${artifactFor("linux-x64")}echo pwned\n`));
      const f = fixture({ withDeps: true });
      const r = await run(f, sh);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("does not match the checksum");
      nothingInstalled(f);
      expect(log(f, "doctor")).toEqual([]);
    }, T);

    it("a file that is right for another platform fails the check (wrong platform), exit 1", async () => {
      serveAll();
      served.set("/v0.1.0/fx-runner-linux-arm64", Buffer.from(artifactFor("linux-x64")));
      const f = fixture({ withDeps: true, uname: ["Linux", "aarch64"] });
      const r = await run(f, sh);
      expect(r.code).toBe(1);
      expect(requests[0]).toBe("/v0.1.0/fx-runner-linux-arm64");
      nothingInstalled(f);
    }, T);

    it("a missing file (404) exits 1 and installs nothing; a redirect to plain http is refused", async () => {
      const f = fixture({ withDeps: true });
      expect((await run(f, sh)).code).toBe(1);
      nothingInstalled(f);
      serveAll();
      redirectToHttp = true;
      const g = fixture({ withDeps: true });
      const r = await run(g, sh);
      expect(r.code).toBe(1);
      nothingInstalled(g);
      expect(requests.filter((u) => u.startsWith("/objects/"))).toEqual([]);
    }, T);

    it("a file that matches its checksum but does not run exits 1 and installs nothing", async () => {
      const broken = artifactFor("linux-x64", 1);
      served.set("/v0.1.0/fx-runner-linux-x64", Buffer.from(broken));
      const f = fixture({ withDeps: true });
      writeFileSync(f.script, render({ sha: { "linux-x64": sha(broken) } }));
      const r = await run(f, sh);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("does not run on this machine");
      nothingInstalled(f);
    }, T);

    it("an unrendered or malformed copy refuses (exit 2) before any request", async () => {
      serveAll();
      for (const text of [SCRIPT_TEXT, render({ sha: { "linux-x64": "abc" } }), render({ sha: { "linux-x64": "G".repeat(64) } }), render({ version: "../../x" })]) {
        const f = fixture({ withDeps: true });
        writeFileSync(f.script, text);
        const r = await run(f, sh);
        expect(r.code, r.out).toBe(2);
        nothingInstalled(f);
      }
      expect(requests).toEqual([]);
    }, T);

    it("a rerun of the same version downloads nothing; a new version is added beside the old one", async () => {
      serveAll();
      serveAll("0.2.0");
      const f = fixture({ withDeps: true });
      expect((await run(f, sh)).code).toBe(0);
      const before = requests.length;
      const again = await run(f, sh);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("already installed");
      expect(requests).toHaveLength(before);
      writeFileSync(f.script, render({ version: "0.2.0" }));
      expect((await run(f, sh)).code).toBe(0);
      expect(existsSync(installed(f, "0.1.0"))).toBe(true);
      expect(existsSync(installed(f, "0.2.0"))).toBe(true);
      expect(readlinkSync(link(f))).toBe("../versions/0.2.0/fx-runner");
    }, T);

    it("a file changed on disk is replaced by a fresh checked download", async () => {
      serveAll();
      const f = fixture({ withDeps: true });
      expect((await run(f, sh)).code).toBe(0);
      writeFileSync(installed(f), "#!/bin/sh\necho evil\n");
      expect((await run(f, sh)).code).toBe(0);
      expect(readFileSync(installed(f), "utf8")).toBe(artifactFor("linux-x64"));
    }, T);
  });

  d("platforms", () => {
    it.each([
      ["WSL2 by /proc/version", { procVersion: "Linux version 5.15.0-microsoft-standard-WSL2 (root@x)\n" }, {}],
      ["WSL by WSL_DISTRO_NAME", {}, { WSL_DISTRO_NAME: "Ubuntu" }],
      ["native Windows (MINGW)", { uname: ["MINGW64_NT-10.0", "x86_64"] as [string, string] }, {}],
    ])("refuses %s with the runner's sentence, exit 2, no request", async (_name, options, env) => {
      serveAll();
      const f = fixture({ withDeps: true, ...options, env });
      const r = await run(f, sh);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(WINDOWS_UNSUPPORTED_NOTICE);
      expect(requests).toEqual([]);
      nothingInstalled(f);
    }, T);

    it.each([[["FreeBSD", "amd64"]], [["Linux", "riscv64"]]])("refuses an unsupported machine %j with exit 2", async (uname) => {
      serveAll();
      const f = fixture({ withDeps: true, uname: uname as [string, string] });
      const r = await run(f, sh);
      expect(r.code).toBe(2);
      expect(requests).toEqual([]);
    }, T);

    it.each([
      ["arm64 Mac", { arm64Mac: undefined }, "darwin-arm64", ["Darwin", "arm64"]],
      ["Intel Mac", { arm64Mac: false }, "darwin-x64", ["Darwin", "x86_64"]],
      ["Rosetta shell on an Apple-silicon Mac", { arm64Mac: true }, "darwin-arm64", ["Darwin", "x86_64"]],
    ])("installs the macOS file for an %s, prints the preview sentence and offers no Linux packages", async (_n, extra, platform, uname) => {
      serveAll();
      const f = fixture({ uname: uname as [string, string], ...extra });
      const r = await run(f, sh);
      expect(r.code, r.out).toBe(0);
      expect(requests[0]).toBe(`/v0.1.0/fx-runner-${platform}`);
      expect(r.stderr).toContain(MACOS_PREVIEW_NOTICE);
      expect(r.out).not.toContain("bubblewrap");
    }, T);
  });

  d("sandbox dependencies", () => {
    const aptCommand = INSTALL_COMMAND.debian;
    it.skipIf(PYTHON === undefined)("answering y runs the exact command once; answering n records zero sudo calls and prints it", async () => {
      serveAll();
      const yes = fixture();
      const r = await runTty(yes, sh, "y");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`Run: ${aptCommand}`);
      expect(log(yes, "sudo")).toEqual(["apt-get install -y bubblewrap socat"]);
      expect(log(yes, "apt-get")).toEqual(["install -y bubblewrap socat"]);
      const no = fixture();
      const n = await runTty(no, sh, "n");
      expect(n.code, n.out).toBe(0);
      expect(n.out).toContain(`Run: ${aptCommand}`);
      expect(n.out).toContain("Not installed");
      expect(log(no, "sudo")).toEqual([]);
      expect(log(no, "apt-get")).toEqual([]);
    }, T);

    it.skipIf(PYTHON === undefined)("as root it still asks, then runs the package manager without sudo", async () => {
      serveAll();
      const f = fixture({ uid: 0 });
      const no = await runTty(f, sh, "n");
      expect(no.out).toContain("Run it now?");
      expect(log(f, "apt-get")).toEqual([]);
      const g = fixture({ uid: 0 });
      await runTty(g, sh, "y");
      expect(log(g, "sudo")).toEqual([]);
      expect(log(g, "apt-get")).toEqual(["install -y bubblewrap socat"]);
    }, T);

    it("non-interactive (no terminal) only prints: zero sudo and zero package-manager calls", async () => {
      serveAll();
      const f = fixture();
      const r = await run(f, sh);
      expect(r.code, r.out).toBe(0);
      expect(r.stdout).toContain(`Run: ${aptCommand}`);
      expect(log(f, "sudo")).toEqual([]);
      expect(log(f, "apt-get")).toEqual([]);
      // --yes without a terminal does not turn it on either: read ITS OWN fixture's logs
      const yes = fixture();
      const y = await run(yes, sh, ["--yes"]);
      expect(y.code, y.out).toBe(0);
      expect(y.stdout).toContain(`Run: ${aptCommand}`);
      expect(log(yes, "sudo")).toEqual([]);
      expect(log(yes, "apt-get")).toEqual([]);
    }, T);

    it.skipIf(PYTHON === undefined)("--non-interactive and CI each print only, even with a terminal and a waiting y; --yes with CI runs it", async () => {
      serveAll();
      const a = fixture();
      await runTty(a, sh, "y", ["--non-interactive"]);
      const b = fixture();
      await runTty(b, sh, "y", [], { CI: "true" });
      for (const x of [a, b]) {
        expect(log(x, "sudo")).toEqual([]);
        expect(log(x, "apt-get")).toEqual([]);
      }
      const c = fixture();
      await runTty(c, sh, "n", ["--yes"], { CI: "true" });
      expect(log(c, "sudo")).toEqual(["apt-get install -y bubblewrap socat"]);
    }, T);

    it.skipIf(PYTHON === undefined)("NixOS prints the environment.systemPackages line and records zero calls even with y waiting", async () => {
      serveAll();
      const f = fixture({ nixos: true, osRelease: "ID=nixos\n" });
      const r = await runTty(f, sh, "y");
      expect(r.out).toContain(NIXOS_CONFIG_LINE);
      for (const name of ["sudo", "apt-get", "dnf", "pacman"]) expect(log(f, name)).toEqual([]);
    }, T);

    it.each([
      ["fedora", "ID=fedora\n", INSTALL_COMMAND.fedora],
      ["arch", 'ID="arch"\n', INSTALL_COMMAND.arch],
      ["ubuntu (like debian)", "ID=ubuntu\nID_LIKE=debian\n", INSTALL_COMMAND.ubuntu],
      ["a derivative named by ID_LIKE", "ID=pop\nID_LIKE=\"ubuntu debian\"\n", INSTALL_COMMAND.ubuntu],
    ])("shows the exact command for %s", async (_n, osRelease, command) => {
      serveAll();
      const f = fixture({ osRelease });
      const r = await run(f, sh);
      expect(r.stdout).toContain(`Run: ${command}`);
    }, T);

    it("an unknown distro gets the generic line and nothing else; present dependencies print nothing", async () => {
      serveAll();
      const f = fixture({ osRelease: "ID=plan9\n" });
      const r = await run(f, sh);
      expect(r.stdout).toContain("Install bubblewrap (bwrap) and socat with your package manager");
      expect(r.stdout).not.toContain("Run: sudo");
      const g = fixture({ withDeps: true });
      expect((await run(g, sh)).out).not.toContain("bubblewrap");
    }, T);
  });

  d("probe and Claude Code", () => {
    it("a failing probe exits 3 with fx-runner still installed, and the probe's own text is shown", async () => {
      serveAll();
      const f = fixture({ withDeps: true, env: { FX_FIXTURE_PROBE: "1" } });
      const r = await run(f, sh);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("bubblewrap cannot create a user namespace (fixture)");
      expect(r.stderr).toContain("fx-runner is installed");
      expect(readFileSync(installed(f), "utf8")).toBe(artifactFor("linux-x64"));
      expect(readlinkSync(link(f))).toBe(`../versions/${VERSION}/fx-runner`);
      expect(log(f, "doctor")).toEqual(["doctor --sandbox-only"]);
    }, T);

    it.each([
      ["missing", null],
      ["older than the minimum", "2.1.293 (Claude Code)"],
      ["a lower major", "1.99.999 (Claude Code)"],
      ["not a version", "hello"],
    ])("Claude Code %s exits 4, prints Anthropic's own install line, never downloads it, and still leaves fx-runner installed", async (_n, claude) => {
      serveAll();
      const f = fixture({ withDeps: true, claude });
      const r = await run(f, sh);
      expect(r.code, r.out).toBe(4);
      expect(r.stderr).toContain("curl -fsSL https://claude.ai/install.sh | bash");
      expect(readFileSync(installed(f), "utf8")).toBe(artifactFor("linux-x64"));
      expect(log(f, "curl")).toHaveLength(1);
    }, T);

    it.each([[MIN_CLAUDE_VERSION], ["2.1.295"], ["2.2.0"], ["3.0.0"], ["2.1.1000"]])("Claude Code %s is accepted (exit 0)", async (version) => {
      serveAll();
      const f = fixture({ withDeps: true, claude: `${version} (Claude Code)` });
      const r = await run(f, sh);
      expect(r.code, r.out).toBe(0);
      expect(r.stdout).toContain(`Claude Code ${version} found at ${path.join(f.tools, "claude")}`);
      expect(log(f, "claude")).toEqual(["x"]);
    }, T);

    it("a failed probe is reported as 3 even when Claude Code is also missing", async () => {
      serveAll();
      const f = fixture({ withDeps: true, claude: null, env: { FX_FIXTURE_PROBE: "1" } });
      const r = await run(f, sh);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("claude.ai/install.sh");
    }, T);
  });

  d("uninstall", () => {
    it("removes bin/ and versions/, leaves the registration and key with a revoke line, and is safe to repeat", async () => {
      serveAll();
      const f = fixture({ withDeps: true });
      expect((await run(f, sh)).code).toBe(0);
      const state = path.join(f.home, ".fx-runner");
      writeFileSync(path.join(state, "registration.json"), '{"version":1}\n');
      writeFileSync(path.join(state, "runner-key.pem"), "fixture key\n");
      const r = await run(f, sh, ["--uninstall"]);
      expect(r.code, r.out).toBe(0);
      expect(r.stderr).toContain("fx-runner revoke");
      expect(existsSync(path.join(state, "bin"))).toBe(false);
      expect(existsSync(path.join(state, "versions"))).toBe(false);
      expect(readFileSync(path.join(state, "registration.json"), "utf8")).toBe('{"version":1}\n');
      expect(readFileSync(path.join(state, "runner-key.pem"), "utf8")).toBe("fixture key\n");
      expect((await run(f, sh, ["--uninstall"])).code).toBe(0);
      // an unrendered copy can still uninstall, and uninstall touches neither the network nor sudo
      writeFileSync(f.script, SCRIPT_TEXT);
      expect((await run(f, sh, ["--uninstall"])).code).toBe(0);
      expect(log(f, "sudo")).toEqual([]);
    }, T);

    it("honours FX_RUNNER_HOME for install and uninstall, and refuses a relative one and unknown options (exit 2)", async () => {
      serveAll();
      const f = fixture({ withDeps: true });
      const custom = path.join(path.dirname(f.home), "custom-state");
      expect((await run(f, sh, [], { FX_RUNNER_HOME: custom })).code).toBe(0);
      expect(existsSync(path.join(custom, "versions", VERSION, "fx-runner"))).toBe(true);
      expect(existsSync(path.join(f.home, ".fx-runner"))).toBe(false);
      expect((await run(f, sh, ["--uninstall"], { FX_RUNNER_HOME: custom })).code).toBe(0);
      expect(existsSync(path.join(custom, "bin"))).toBe(false);
      expect((await run(f, sh, [], { FX_RUNNER_HOME: "relative/dir" })).code).toBe(2);
      expect((await run(f, sh, ["--frobnicate"])).code).toBe(2);
      expect(lstatSync(path.join(custom)).isDirectory()).toBe(true);
    }, T);
  });

  d("state directory safety", () => {
    /** A user's own files that neither install nor uninstall may touch, in the home directory and in its parent. */
    function plant(f: Fixture): string[] {
      mkdirSync(path.join(f.home, "bin"));
      writeFileSync(path.join(f.home, "bin", "mytool"), "my tool\n");
      mkdirSync(path.join(f.home, "versions"));
      writeFileSync(path.join(f.home, "versions", "keep"), "keep\n");
      const parent = path.dirname(f.home);
      mkdirSync(path.join(parent, "bin"));
      writeFileSync(path.join(parent, "bin", "keep"), "keep\n");
      mkdirSync(path.join(parent, "versions"));
      writeFileSync(path.join(parent, "versions", "keep"), "keep\n");
      return snapshot(parent);
    }
    const badHomes: [string, (f: Fixture) => string][] = [
      ["$HOME itself", (f) => f.home],
      ["$HOME with a trailing slash", (f) => `${f.home}/`],
      ["$HOME with two trailing slashes", (f) => `${f.home}//`],
      ["the parent of $HOME", (f) => path.dirname(f.home)],
      ["a symlink that resolves to $HOME", (f) => symlinkTo(f.home, path.join(path.dirname(f.home), "to-home"))],
      ["a symlink that resolves to the parent of $HOME", (f) => symlinkTo(path.dirname(f.home), path.join(path.dirname(f.home), "to-parent"))],
      ["/", () => "/"],
      ["//", () => "//"],
      ["///", () => "///"],
      ["a path ending in /.", (f) => `${f.home}/.`],
      ["a path ending in /..", (f) => `${f.home}/..`],
      ["a . segment", (f) => `${f.home}/./.fx-runner`],
      ["a .. segment", (f) => `${f.home}/x/../.fx-runner`],
      ["a relative path", () => "relative/dir"],
      ["a bare dot", () => "."],
      ["two dots", () => ".."],
    ];
    it.each(badHomes)("uninstall refuses %s (exit 2) and removes nothing", async (_name, home) => {
      const f = fixture({ withDeps: true });
      const h = home(f);
      const before = plant(f);
      const r = await run(f, sh, ["--uninstall"], { FX_RUNNER_HOME: h });
      expect(r.code, r.out).toBe(2);
      expect(snapshot(path.dirname(f.home))).toEqual(before);
      expect(readFileSync(path.join(f.home, "bin", "mytool"), "utf8")).toBe("my tool\n");
    }, T);

    it("the reviewer's reproduction: FX_RUNNER_HOME=$HOME --uninstall leaves ~/bin/mytool and exits non-zero", async () => {
      const f = fixture({ withDeps: true });
      plant(f);
      const r = await run(f, sh, ["--uninstall"], { FX_RUNNER_HOME: f.home });
      expect(r.code).not.toBe(0);
      expect(readFileSync(path.join(f.home, "bin", "mytool"), "utf8")).toBe("my tool\n");
      expect(readFileSync(path.join(f.home, "versions", "keep"), "utf8")).toBe("keep\n");
    }, T);

    it.each(badHomes.slice(0, 6))("install refuses %s (exit 2) before any request and writes nothing", async (_name, home) => {
      serveAll();
      const f = fixture({ withDeps: true });
      const h = home(f);
      const before = plant(f);
      const r = await run(f, sh, [], { FX_RUNNER_HOME: h });
      expect(r.code, r.out).toBe(2);
      expect(requests).toEqual([]);
      expect(snapshot(path.dirname(f.home))).toEqual(before);
    }, T);

    it("uninstall removes only bin/fx-runner and versions/, and keeps a bin/ that holds other files", async () => {
      serveAll();
      const f = fixture({ withDeps: true });
      expect((await run(f, sh)).code).toBe(0);
      const state = path.join(f.home, ".fx-runner");
      writeFileSync(path.join(state, "bin", "other-tool"), "other\n");
      writeFileSync(path.join(state, "notes.txt"), "notes\n");
      const r = await run(f, sh, ["--uninstall"]);
      expect(r.code, r.out).toBe(0);
      expect(readdirSync(path.join(state, "bin"))).toEqual(["other-tool"]);
      expect(existsSync(path.join(state, "versions"))).toBe(false);
      expect(readFileSync(path.join(state, "notes.txt"), "utf8")).toBe("notes\n");
    }, T);

    it("a state directory reached through a symlink is accepted when it is not $HOME or a parent of it", async () => {
      serveAll();
      const f = fixture({ withDeps: true });
      const real = path.join(path.dirname(f.home), "real-state");
      mkdirSync(real);
      const viaLink = symlinkTo(real, path.join(path.dirname(f.home), "state-link"));
      expect((await run(f, sh, [], { FX_RUNNER_HOME: viaLink })).code).toBe(0);
      expect(existsSync(path.join(real, "versions", VERSION, "fx-runner"))).toBe(true);
      expect((await run(f, sh, ["--uninstall"], { FX_RUNNER_HOME: viaLink })).code).toBe(0);
      expect(existsSync(path.join(real, "versions"))).toBe(false);
    }, T);

    // Symlinks and wrong file types inside the state directory. Each case: exit 1, a clear message, nothing changed anywhere.
    const layouts: [string, (state: string, outside: string) => void, string][] = [
      ["versions is a symlink", (s, o) => symlinkSync(o, path.join(s, "versions")), "symbolic link"],
      ["bin is a symlink", (s, o) => symlinkSync(o, path.join(s, "bin")), "symbolic link"],
      ["versions/<version> is a symlink", (s, o) => (mkdirSync(path.join(s, "versions")), symlinkSync(o, path.join(s, "versions", VERSION))), "symbolic link"],
      ["bin/fx-runner is a directory", (s) => mkdirSync(path.join(s, "bin", "fx-runner"), { recursive: true }), "not a symbolic link"],
      ["bin/fx-runner is a regular file", (s) => (mkdirSync(path.join(s, "bin")), writeFileSync(path.join(s, "bin", "fx-runner"), "mine\n")), "not a symbolic link"],
      ["versions is a regular file", (s) => writeFileSync(path.join(s, "versions"), "file\n"), "not a directory"],
      ["bin is a regular file", (s) => writeFileSync(path.join(s, "bin"), "file\n"), "not a directory"],
      ["versions/<version> is a regular file", (s) => (mkdirSync(path.join(s, "versions")), writeFileSync(path.join(s, "versions", VERSION), "file\n")), "not a directory"],
    ];
    it.each(layouts)("install refuses when %s", async (_name, setup, message) => {
      serveAll();
      const f = fixture({ withDeps: true });
      const outside = path.join(path.dirname(f.home), "outside");
      mkdirSync(path.join(outside, VERSION), { recursive: true });
      writeFileSync(path.join(outside, VERSION, "sentinel"), "outside\n");
      const state = path.join(f.home, ".fx-runner");
      mkdirSync(state);
      setup(state, outside);
      const before = [snapshot(state), snapshot(outside)];
      const r = await run(f, sh);
      expect(r.code, r.out).toBe(1);
      expect(r.stderr).toContain(message);
      expect(requests).toEqual([]);
      expect([snapshot(state), snapshot(outside)]).toEqual(before);
      expect(readFileSync(path.join(outside, VERSION, "sentinel"), "utf8")).toBe("outside\n");
      expect(log(f, "doctor")).toEqual([]);
    }, T);

    it.each(layouts.filter(([name]) => !name.startsWith("versions/")))("uninstall refuses when %s", async (_name, setup, message) => {
      const f = fixture({ withDeps: true });
      const outside = path.join(path.dirname(f.home), "outside");
      mkdirSync(path.join(outside, VERSION), { recursive: true });
      writeFileSync(path.join(outside, VERSION, "sentinel"), "outside\n");
      const state = path.join(f.home, ".fx-runner");
      mkdirSync(state);
      setup(state, outside);
      const before = [snapshot(state), snapshot(outside)];
      const r = await run(f, sh, ["--uninstall"]);
      expect(r.code, r.out).toBe(1);
      expect(r.stderr).toContain(message);
      expect([snapshot(state), snapshot(outside)]).toEqual(before);
    }, T);

    it("uninstall removes a versions/<version> symlink as a link and never touches what it points at", async () => {
      const f = fixture({ withDeps: true });
      const outside = path.join(path.dirname(f.home), "outside");
      mkdirSync(path.join(outside, VERSION), { recursive: true });
      writeFileSync(path.join(outside, VERSION, "sentinel"), "outside\n");
      const state = path.join(f.home, ".fx-runner");
      mkdirSync(path.join(state, "versions"), { recursive: true });
      symlinkSync(outside, path.join(state, "versions", VERSION));
      const before = snapshot(outside);
      const r = await run(f, sh, ["--uninstall"]);
      expect(r.code, r.out).toBe(0);
      expect(existsSync(path.join(state, "versions"))).toBe(false);
      expect(snapshot(outside)).toEqual(before);
    }, T);

    it("an existing bin/fx-runner symlink that points at a directory is replaced, never written through", async () => {
      serveAll();
      const f = fixture({ withDeps: true });
      const state = path.join(f.home, ".fx-runner");
      const elsewhere = path.join(path.dirname(f.home), "elsewhere");
      mkdirSync(elsewhere);
      mkdirSync(path.join(state, "bin"), { recursive: true });
      symlinkSync(elsewhere, path.join(state, "bin", "fx-runner"));
      const r = await run(f, sh);
      expect(r.code, r.out).toBe(0);
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(readlinkSync(link(f))).toBe(`../versions/${VERSION}/fx-runner`);
    }, T);

    it("a state directory that is a regular file is refused (exit 1) and left alone", async () => {
      serveAll();
      const f = fixture({ withDeps: true });
      const state = path.join(f.home, ".fx-runner");
      writeFileSync(state, "file\n");
      const r = await run(f, sh);
      expect(r.code, r.out).toBe(1);
      expect(readFileSync(state, "utf8")).toBe("file\n");
    }, T);
  });

  d("rendering", () => {
    it.each([
      ["darwin-arm64", "@FX_SHA256_DARWIN_ARM64@"],
      ["darwin-x64", "@FX_SHA256_DARWIN_X64@"],
      ["linux-arm64", "@FX_SHA256_LINUX_ARM64@"],
    ])("a copy with the %s placeholder left in refuses (exit 2) on linux-x64, before any request", async (platform, placeholder) => {
      serveAll();
      const f = fixture({ withDeps: true });
      writeFileSync(f.script, render({ sha: { [platform]: placeholder } }));
      expect(readFileSync(f.script, "utf8")).toContain(placeholder);
      const r = await run(f, sh);
      expect(r.code, r.out).toBe(2);
      expect(r.stderr).toContain(platform);
      expect(requests).toEqual([]);
      nothingInstalled(f);
    }, T);
  });

  d("stdin, environment and truncation", () => {
    it("the downloaded binary runs with NODE_OPTIONS and NODE_PATH cleared, for --version and for doctor", async () => {
      serveAll();
      const f = fixture({ withDeps: true });
      const r = await run(f, sh, [], { NODE_OPTIONS: "--require /nonexistent/preload.js", NODE_PATH: "/nonexistent/modules" });
      expect(r.code, r.out).toBe(0);
      expect(log(f, "env")).toEqual(["--version NODE_OPTIONS=unset NODE_PATH=unset", "doctor NODE_OPTIONS=unset NODE_PATH=unset"]);
    }, T);

    it("the downloaded binary's --version and doctor, and the Claude check, read /dev/null, not the piped script", async () => {
      serveAll();
      for (const claude of [undefined, null]) {
        const f = fixture({ withDeps: true, claude });
        const r = await runPiped(f, sh, `${render()}SECRET-TAIL\n`, [], { FX_TEST_READ_STDIN: "1" });
        expect(r.code, r.out).toBe(claude === null ? 4 : 0);
        // the Claude check and the closing lines still ran
        if (claude === null) expect(r.stderr).toContain("claude.ai/install.sh");
        else expect(r.stdout).toContain("Claude Code");
        expect(r.stdout).toContain("Sandbox check passed.");
        expect(r.stdout).toContain("Next: fx-runner register");
        for (const name of ["stdin---version", "stdin-doctor", ...(claude === null ? [] : ["stdin-claude"])]) {
          expect(existsSync(path.join(f.logs, `${name}.log`)), `${name} was not recorded`).toBe(true);
          expect(readFileSync(path.join(f.logs, `${name}.log`), "utf8"), name).toBe("");
        }
      }
    }, T);

    it.skipIf(PYTHON === undefined)("the package manager reads the terminal, not the piped script", async () => {
      serveAll();
      const f = fixture();
      const r = await runTty(f, sh, "y\nTYPED-AT-THE-TERMINAL", [], { FX_TEST_PIPE_SCRIPT: "1", FX_TEST_READ_STDIN: "1" });
      expect(r.code, r.out).toBe(0);
      expect(log(f, "sudo")).toEqual(["apt-get install -y bubblewrap socat"]);
      expect(log(f, "apt-get-stdin")).toEqual(["TYPED-AT-THE-TERMINAL"]);
      expect(r.out).toContain("Next: fx-runner register");
    }, T);

    it("every truncation of the script, piped to the shell, either fails or does nothing at all", async () => {
      serveAll();
      const text = render();
      const lines = text.split("\n");
      const f = fixture({ withDeps: true });
      const state = path.join(f.home, ".fx-runner");
      let failed = 0;
      for (let k = 1; k < lines.length - 1; k++) {
        const r = await runPiped(f, sh, `${lines.slice(0, k).join("\n")}\n`);
        if (r.code !== 0) {
          failed++;
          continue;
        }
        expect({ k, out: r.out, installed: existsSync(state), requests }).toEqual({ k, out: "", installed: false, requests: [] });
      }
      expect(failed).toBeGreaterThan(100); // most cut points land inside main() and are syntax errors
      // the cut the reviewer used, in the middle of the install: a non-zero exit, and nothing installed
      const midLine = lines.findIndex((l) => l.includes("download, check, install")) + 10;
      expect(midLine).toBeGreaterThan(10);
      const mid = await runPiped(f, sh, `${lines.slice(0, midLine).join("\n")}\n`);
      expect(mid.code).not.toBe(0);
      expect(existsSync(state)).toBe(false);
      // a cut inside the last line is a syntax error as well
      const tail = await runPiped(f, sh, text.slice(0, -3));
      expect(tail.code).not.toBe(0);
      expect(existsSync(state)).toBe(false);
      expect(requests).toEqual([]);
    }, 120_000);
  });
});

// the shells above are probed for by name; make an absent one visible in the report instead of silently skipping
describe("install.sh shell coverage", () => {
  it.each([["bash", BASH], ["dash", DASH]])("%s was available to run the cases", (name, found) => {
    if (found === undefined && !STRICT) console.warn(`${name} not found: its cases were skipped`);
    else expect(found).toBeDefined();
  });
});
