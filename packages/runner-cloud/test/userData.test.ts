import { describe, expect, it } from "vitest";
import { NODESOURCE_KEY_FINGERPRINT, STAGE_DIR, USER_DATA_MAX_BYTES, boundSourceIp, renderUserData, type UserDataInput } from "../src/index.js";

const SECRET = "fxrp_" + "AbCdEfGhIj".repeat(4);
const ORIGIN = "https://cloud.example.test";
const input = (over: Partial<UserDataInput> = {}): UserDataInput => ({ origin: ORIGIN, credentialMode: "subscription", token: { secret: SECRET, ttlSeconds: 1800, repoCount: 0 }, ...over });

interface WriteFile {
  path: string;
  owner: string;
  permissions: string;
  content: string;
}
const parse = (text: string): { ssh_pwauth: boolean; write_files: WriteFile[]; runcmd: string[][] } => {
  expect(text.startsWith("#cloud-config\n")).toBe(true);
  return JSON.parse(text.slice("#cloud-config\n".length));
};
const file = (text: string, path: string): WriteFile => {
  const f = parse(text).write_files.find((w) => w.path === path);
  if (!f) throw new Error(`no file ${path}`);
  return f;
};

describe("renderUserData (D#845 MC-5)", () => {
  it("is a #cloud-config of at most 32 KiB that runs one script and turns password SSH off", () => {
    const text = renderUserData(input());
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(USER_DATA_MAX_BYTES);
    const cfg = parse(text);
    expect(cfg.ssh_pwauth).toBe(false);
    expect(cfg.runcmd).toEqual([["/usr/local/sbin/fx-bootstrap"]]);
    expect(file(text, "/usr/local/sbin/fx-bootstrap").permissions).toBe("0700");
  });

  it("holds exactly one fxrp_ string and no other secret-shaped string", () => {
    const text = renderUserData(input());
    expect(text.match(/fxrp_/g)).toHaveLength(1);
    expect(text.match(/fxrp_[A-Za-z0-9]+/g)).toEqual([SECRET]);
    // The one other long hex string is the pinned public key fingerprint (not a secret); it must be exactly that constant.
    const rest = text.replace(SECRET, "").replace(NODESOURCE_KEY_FINGERPRINT, "");
    expect(text.split(NODESOURCE_KEY_FINGERPRINT)).toHaveLength(2);
    // Nothing the shape of a key: a 32-plus run of letters and digits, a hex run, a known vendor prefix, a private key block, a bearer or basic credential, a credentialed URL.
    expect(rest).not.toMatch(/[A-Za-z0-9]{32,}/);
    expect(rest).not.toMatch(/\b(?:sk-|ghp_|ghs_|gho_|github_pat_|xox[abp]-|AKIA|fxrr_|fxrp_)[A-Za-z0-9_-]*/);
    expect(rest).not.toMatch(/-----BEGIN/);
    expect(rest).not.toMatch(/(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i);
    expect(rest).not.toMatch(/https?:\/\/[^/\s"']*@/);
    expect(rest).not.toMatch(/(?:password|secret|api[_-]?key)\s*[:=]\s*[^\s"'n]/i);
  });

  it("puts the token in a root-only 0600 file and never in the script, the units or the command line", () => {
    const text = renderUserData(input());
    const cfg = parse(text);
    const holders = cfg.write_files.filter((w) => w.content.includes(SECRET));
    expect(holders).toEqual([{ path: "/root/.fx-provisioning-token", owner: "root:root", permissions: "0600", content: SECRET }]);
    expect(JSON.stringify(cfg.runcmd)).not.toContain(SECRET);
    const script = file(text, "/usr/local/sbin/fx-bootstrap").content;
    // It is read from the file on standard input (never as an argument), and the file goes at the end of the register stage and on every exit.
    expect(script).toContain('--code-stdin');
    expect(script).toContain('<"$TOKEN_FILE" && rm -f "$TOKEN_FILE"');
    expect(script).toContain("trap 'rm -f \"$TOKEN_FILE\"' EXIT");
    expect(script).not.toMatch(/--code[ =]/);
  });

  it("writes its stages to /var/lib/fx/stage, in order, ending with done", () => {
    const script = file(renderUserData(input()), "/usr/local/sbin/fx-bootstrap").content;
    expect(STAGE_DIR).toBe("/var/lib/fx/stage");
    expect(script).toContain("STAGE=/var/lib/fx/stage");
    const order = [...script.matchAll(/^stage (\S+) /gm)].map((m) => m[1]);
    expect(order).toEqual(["01-metadata-drop", "02-user", "03-upgrades", "04-packages", "05-claude", "06-runner", "07-register", "08-service", "09-ssh", "10-verify", "done"]);
    expect(script).toContain('echo "$name" >"$STAGE/failed"');
  });

  it("makes the fx user with no password and no sudo, and installs the listed packages", () => {
    const script = file(renderUserData(input()), "/usr/local/sbin/fx-bootstrap").content;
    expect(script).toContain("useradd --create-home --shell /bin/bash fx");
    expect(script).not.toMatch(/useradd[^\n]*(-G|--groups|-p |--password)/);
    expect(script).not.toMatch(/sudo|NOPASSWD/);
    expect(script).toContain("apt-get install -y git python3 bubblewrap build-essential nodejs");
    expect(script).toContain("node_22.x");
    expect(script).toContain("apt-get install -y unattended-upgrades");
    expect(file(renderUserData(input()), "/etc/apt/apt.conf.d/20auto-upgrades").content).toContain('Unattended-Upgrade "1"');
  });

  it("installs the runner with ONE fixed command from the cloud's own origin, and no hash or verifier of its own", () => {
    const text = renderUserData(input());
    const script = file(text, "/usr/local/sbin/fx-bootstrap").content;
    const runnerLine = script.split("\n").filter((l) => l.startsWith("s_runner()"));
    // Downloaded to a file and then run with sh, never piped: a refusing script answers 200 and exits 1, and a pipe hides that exit. The exit code is the stage's.
    expect(runnerLine).toEqual([`s_runner() { runuser -l fx -c 'f=$(mktemp) && curl --proto =https --tlsv1.2 -fsSL ${ORIGIN}/install.sh -o "$f" && sh "$f" --yes --non-interactive; rc=$?; rm -f "$f"; exit $rc'; }`]);
    expect(runnerLine[0]).not.toMatch(/install\.sh\s*\|/);
    expect(script).toContain('stage 06-runner s_runner');
    expect(script).toContain('echo "$name" >"$STAGE/failed"');
    expect(script).not.toMatch(/sha256|sha512|b3sum|cosign|tuf|root\.json|--version/i);
    // The only places the origin is fetched from are that one line and the register stage's --cloud-url.
    expect(script.split(ORIGIN).length - 1).toBe(3); // ORIGIN=..., the install line, the register line
  });

  it("drops traffic to the metadata address for every uid but root, from a unit that runs on every boot", () => {
    const text = renderUserData(input());
    const unit = file(text, "/etc/systemd/system/fx-metadata-drop.service").content;
    expect(unit).toContain("-d 169.254.169.254 -m owner ! --uid-owner 0 -j DROP");
    expect(unit).toContain("iptables -C OUTPUT"); // idempotent: checked before inserted
    expect(unit).toMatch(/Before=network-pre\.target/);
    expect(unit).toMatch(/WantedBy=multi-user\.target/);
    const script = file(text, "/usr/local/sbin/fx-bootstrap").content;
    expect(script).toContain("systemctl enable --now fx-metadata-drop.service");
    // It is the first stage, before any code runs as fx, and the last stage checks it as fx.
    expect(script.indexOf("stage 01-metadata-drop")).toBeLessThan(script.indexOf("stage 02-user"));
    expect(script).toContain("runuser -u fx -- curl -s -m 3 -o /dev/null http://169.254.169.254/");
  });

  it("turns password SSH off and locks root's password, with the drop-in read before the image's own", () => {
    const text = renderUserData(input());
    const ssh = file(text, "/etc/ssh/sshd_config.d/00-fx.conf").content;
    expect(ssh).toContain("PasswordAuthentication no");
    expect(ssh).toContain("PermitRootLogin prohibit-password");
    const script = file(text, "/usr/local/sbin/fx-bootstrap").content;
    expect(script).toContain("passwd -l root");
    expect(script).toContain("sshd -T | grep -qi '^passwordauthentication no'");
    // Ubuntu 24.04 socket-activates ssh, so the service is usually not running: a plain reload would fail the stage. This one is a no-op then.
    // `sshd -T` needs its privilege-separation directory, which only a started service makes (found by the local boot: "Missing privilege separation directory: /run/sshd").
    expect(script).toContain("passwd -l root && systemctl try-reload-or-restart ssh.service && install -d -m u=rwx,go=rx /run/sshd && sshd -T");
    expect(script).not.toMatch(/systemctl reload/);
  });

  it("checks the NodeSource key against the pinned fingerprint before it becomes apt's keyring", () => {
    const script = file(renderUserData(input()), "/usr/local/sbin/fx-bootstrap").content;
    expect(NODESOURCE_KEY_FINGERPRINT).toMatch(/^[0-9A-F]{40}$/);
    expect(script).toContain(`NODESOURCE_FPR=${NODESOURCE_KEY_FINGERPRINT}`);
    const line = script.split("\n").find((l) => l.startsWith("s_packages()"))!;
    expect(line).not.toMatch(/curl[^&]*\|/); // fetched to a file, never piped into gpg
    expect(line).toContain('= "$NODESOURCE_FPR"');
    expect(line).toContain("grep -c '^pub:')\" = 1");
    expect(line.indexOf('= "$NODESOURCE_FPR"')).toBeLessThan(line.indexOf("--dearmor"));
    expect(line).toContain("--proto =https --tlsv1.2");
  });

  it("sets up the user service with linger", () => {
    const script = file(renderUserData(input()), "/usr/local/sbin/fx-bootstrap").content;
    expect(script).toContain("loginctl enable-linger fx");
    expect(script).toContain("fx-runner service install");
  });

  it("refuses a token that is not the S-2 shape: another life, any repositories, a malformed secret", () => {
    for (const ttlSeconds of [1799, 1801, 3600, 86400, 0]) expect(() => renderUserData(input({ token: { secret: SECRET, ttlSeconds, repoCount: 0 } })), String(ttlSeconds)).toThrow(/30 minutes/);
    expect(() => renderUserData(input({ token: { secret: SECRET, ttlSeconds: 1800, repoCount: 1 } }))).toThrow(/no repositories/);
    for (const secret of ["fxrr_" + "a".repeat(40), "fxrp_short", SECRET + "x", `${SECRET}\nrm -rf /`, "", "'; id #"]) {
      expect(() => renderUserData(input({ token: { secret, ttlSeconds: 1800, repoCount: 0 } })), secret).toThrow(/provisioning token/);
    }
  });

  it("refuses an origin that is not a plain https origin, so nothing can ride into the shell script", () => {
    for (const origin of ["http://cloud.example.test", "https://cloud.example.test/", "https://cloud.example.test/x", "https://a b", "https://x';id;'", "https://u@cloud.example.test", "https://cloud.example.test:99999999", "https://$(id)", "https://", "", "https://-x"]) {
      expect(() => renderUserData(input({ origin })), origin).toThrow(/origin/);
    }
    expect(() => renderUserData(input({ origin: "https://cloud.example.test:8443" }))).not.toThrow();
  });

  it("is a function of its inputs alone", () => {
    expect(renderUserData(input())).toBe(renderUserData(input()));
    expect(renderUserData(input({ credentialMode: "api_key" }))).toContain("--credential-mode api_key");
  });
});

describe("boundSourceIp", () => {
  it("reads only the platform-set header", () => {
    expect(boundSourceIp({ "x-vercel-forwarded-for": "203.0.113.7" })).toBe("203.0.113.7");
    expect(boundSourceIp({ "x-forwarded-for": "203.0.113.7" })).toBeUndefined();
    expect(boundSourceIp({ "x-real-ip": "203.0.113.7" })).toBeUndefined();
    expect(boundSourceIp({ "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "198.51.100.1" })).toBe("203.0.113.7");
  });

  it("fails closed on a missing, empty, listed or malformed value", () => {
    for (const v of [undefined, "", "  ", "203.0.113.7, 198.51.100.1", "unknown", "203.0.113.7:80", "fe80::1%eth0", "300.1.1.1"]) {
      expect(boundSourceIp({ "x-vercel-forwarded-for": v }), String(v)).toBeUndefined();
    }
    expect(boundSourceIp({})).toBeUndefined();
  });

  it("reads an IPv4-mapped address as the IPv4 it carries", () => {
    expect(boundSourceIp({ "x-vercel-forwarded-for": "::ffff:203.0.113.7" })).toBe("203.0.113.7");
    expect(boundSourceIp({ "x-vercel-forwarded-for": "2001:db8::1" })).toBe("2001:db8::1");
  });
});
