import { describe, expect, it } from "vitest";
import { JobAllowancesSchema, MAX_CHECK_TIMEOUT_S, MAX_COMMAND_TIMEOUT_S, allowanceFloorViolation, allowanceSetSha256, parseAllowanceSet, type AllowanceEntry, type AllowanceRefusal } from "../src/index.js";

const why = "needed by a step of check.sh, proved by a denial";
const path = (value: string, access: "read" | "write" = "read"): AllowanceEntry => ({ kind: "path", value, access, reason: why });
const domain = (value: string): AllowanceEntry => ({ kind: "domain", value, access: "connect", reason: why });
const loopback = (value: string, access: AllowanceEntry["access"] = "bind"): AllowanceEntry => ({ kind: "loopback", value, access, reason: why });
const refusals = (entries: AllowanceEntry[]): Array<AllowanceRefusal | null> => entries.map(allowanceFloorViolation);

describe("the allowance floor (D#6 R7a, C35 amending C15 section 3)", () => {
  it("lets through the entries the self-build expects: /nix/store read, the npm registry, a scratch write, the loopback bind", () => {
    expect(refusals([path("/nix/store"), path("/tmp/fx-scratch", "write"), domain("registry.npmjs.org"), loopback("127.0.0.1")])).toEqual([null, null, null, null]);
  });

  it.each([
    ["the root", "/", "path_malformed"],
    ["a relative path", "etc/passwd", "path_malformed"],
    ["a home shorthand", "~/.ssh", "path_malformed"],
    ["a variable", "$HOME/work", "path_malformed"],
    ["a parent segment", "/nix/store/../../etc", "path_malformed"],
    ["a dot segment", "/nix/./store", "path_malformed"],
    ["a doubled slash", "/nix//store", "path_malformed"],
    ["a trailing slash", "/nix/store/", "path_malformed"],
    ["a glob", "/nix/*", "path_malformed"],
    ["a shell metacharacter", "/tmp/a;b", "path_malformed"],
    ["a backslash", "/tmp/a\\b", "path_malformed"],
    ["a non-ASCII name", "/tmp/café", "path_malformed"],
    ["/home", "/home", "path_home"],
    ["a user's home", "/home/ian/work", "path_home"],
    ["a user's home on macOS", "/Users/ian", "path_home"],
    ["root's home", "/root/.cache", "path_home"],
    ["~/.ssh by absolute path", "/nix/store/.ssh", "path_credential"],
    ["a credential directory under a granted tree", "/opt/tools/.aws/credentials", "path_credential"],
    ["the gh config", "/opt/x/.config/gh/hosts.yml", "path_credential"],
    ["the runner's own config", "/opt/x/.config/fx-runner", "path_credential"],
    ["the runner's state directory", "/opt/x/.fx-runner/keys", "path_credential"],
    ["the Claude directory", "/opt/x/.claude", "path_credential"],
    ["a keychain folder, in any case", "/opt/x/Library/KeyChains", "path_credential"],
    ["an npmrc", "/opt/x/.npmrc", "path_credential"],
    ["/etc", "/etc", "path_system"],
    ["a file in /etc", "/etc/hosts", "path_system"],
    ["/proc", "/proc/self", "path_system"],
    ["/dev/shm", "/dev/shm", "path_system"],
    ["/run", "/run/user/1000", "path_system"],
    ["the Nix daemon directory", "/nix/var/nix/daemon-socket", "path_socket"],
    ["a docker socket", "/var/run/docker.sock", "path_socket"],
    ["any .sock file", "/tmp/pg/.s.PGSQL.5432.sock", "path_socket"],
    ["any daemon-socket directory", "/opt/nix/daemon-socket", "path_socket"],
    ["/var/run", "/var/run/foo", "path_system"],
    ["macOS /private/etc", "/private/etc/hosts", "path_system"],
  ] as const)("refuses %s", (_name, value, expected) => {
    expect(allowanceFloorViolation(path(value))).toBe(expected);
  });

  it("refuses an ancestor of a forbidden root, not only a path under one: /nix would hand over the daemon socket, /var the run and docker directories", () => {
    // /var is refused as the ancestor of both /var/home (a home) and /var/run; the home rule reports first.
    expect(refusals([path("/nix"), path("/var"), path("/var/lib"), path("/nix/var"), path("/var/run"), path("/var/lib/docker")])).toEqual([
      "path_system", "path_home", "path_system", "path_system", "path_system", "path_system",
    ]);
    expect(allowanceFloorViolation(path("/"))).toBe("path_malformed");
    // Siblings of a root are not ancestors of it, and stay grantable.
    expect(refusals([path("/nix/store"), path("/var/tmp"), path("/var/lib/foo"), path("/nixos"), path("/variable")])).toEqual([null, null, null, null, null]);
    // The usr tree is an ancestor of no forbidden root, so the rule leaves it grantable for reads. A write there is still refused.
    expect(allowanceFloorViolation(path("/usr"))).toBeNull();
    expect(allowanceFloorViolation(path("/usr", "write"))).toBe("path_write_outside_tmp");
  });

  it("refuses the whole of /tmp, read or write, and the home-like roots and mounts", () => {
    expect(allowanceFloorViolation(path("/tmp"))).toBe("path_bare_tmp");
    expect(allowanceFloorViolation(path("/tmp", "write"))).toBe("path_bare_tmp");
    expect(allowanceFloorViolation(path("/tmp/fx-scratch"))).toBeNull();
    for (const value of ["/var/home", "/var/home/ian", "/var/root", "/var/home/ian/projects", "/var/root/.ssh-less", "/mnt/c/Users/ian", "/System/Volumes/Data/Users/ian/x", "/System/Volumes/Data", "/System/Volumes", "/System", "/var/roothome", "/var/roothome/x", "/var/mnt", "/var/mnt/x", "/Volumes", "/Volumes/Data/x", "/mnt", "/mnt/disk", "/media", "/media/usb"]) expect(allowanceFloorViolation(path(value)), value).toBe("path_home");
  });

  it("allows a write only strictly under /tmp", () => {
    for (const value of ["/nix/store", "/usr/local", "/var/tmp/x"]) expect(allowanceFloorViolation(path(value, "write")), value).toBe("path_write_outside_tmp");
    expect(allowanceFloorViolation(path("/tmp/x", "write"))).toBeNull();
  });

  it("refuses a wildcard, an address, a private name and anything that is not a lowercase DNS name", () => {
    const cases: Array<[string, AllowanceRefusal]> = [
      ["*.npmjs.org", "domain_wildcard"],
      ["*", "domain_wildcard"],
      ["1.2.3.4", "domain_address"],
      ["169.254.169.254", "domain_address"],
      ["127.0.0.1", "domain_address"],
      ["2130706433", "domain_address"],
      ["0x7f.0.0.1", "domain_address"],
      ["[::1]", "domain_address"],
      ["::1", "domain_address"],
      ["registry.npmjs.org:443", "domain_address"],
      ["localhost", "domain_malformed"],
      ["db.localhost", "domain_private"],
      ["printer.local", "domain_private"],
      ["metadata.google.internal", "domain_private"],
      ["nas.lan", "domain_private"],
      ["Registry.npmjs.org", "domain_malformed"],
      ["registry.npmjs.org.", "domain_malformed"],
      ["a_b.example.com", "domain_malformed"],
      ["example", "domain_malformed"],
      ["-a.example.com", "domain_malformed"],
    ];
    for (const [value, expected] of cases) expect(allowanceFloorViolation(domain(value)), value).toBe(expected);
  });

  it("takes loopback only as a bind of 127.0.0.1", () => {
    expect(allowanceFloorViolation(loopback("localhost"))).toBe("loopback_value");
    expect(allowanceFloorViolation(loopback("0.0.0.0"))).toBe("loopback_value");
    expect(allowanceFloorViolation(loopback("::1"))).toBe("loopback_value");
    expect(allowanceFloorViolation(loopback("127.0.0.1", "connect"))).toBe("access_not_allowed_for_kind");
  });

  it("refuses an access the kind does not take", () => {
    expect(allowanceFloorViolation({ ...domain("example.com"), access: "write" })).toBe("access_not_allowed_for_kind");
    expect(allowanceFloorViolation({ ...path("/nix/store"), access: "connect" })).toBe("access_not_allowed_for_kind");
  });
});

describe("parseAllowanceSet", () => {
  const set = (entries: AllowanceEntry[], command_timeout_s?: number) => ({ entries, ...(command_timeout_s === undefined ? {} : { command_timeout_s }) });

  it("reads a set, sorts its entries and answers the same hash for the same set in any order", () => {
    const a = parseAllowanceSet(set([domain("registry.npmjs.org"), path("/nix/store")], 900));
    const b = parseAllowanceSet(set([path("/nix/store"), domain("registry.npmjs.org")], 900));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.set.entries.map((e) => e.kind)).toEqual(["domain", "path"]);
    expect(allowanceSetSha256(a.set)).toBe(allowanceSetSha256(b.set));
    expect(allowanceSetSha256(a.set)).toMatch(/^[0-9a-f]{64}$/);
    const c = parseAllowanceSet(set([domain("registry.npmjs.org"), path("/nix/store")], 901));
    expect(c.ok && allowanceSetSha256(c.set)).not.toBe(allowanceSetSha256(a.set));
  });

  it("the empty set is valid, takes no timeout, and has a hash of its own", () => {
    const empty = parseAllowanceSet(set([]));
    expect(empty).toEqual({ ok: true, set: { entries: [] } });
    expect(parseAllowanceSet(set([], 600))).toEqual({ ok: false, code: "timeout_without_entries", index: null });
    expect(empty.ok && allowanceSetSha256(empty.set)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a set with entries needs a timeout of 1 to 1800", () => {
    expect(parseAllowanceSet(set([path("/nix/store")]))).toEqual({ ok: false, code: "entries_without_timeout", index: null });
    for (const bad of [0, 1801, 1.5, -3]) expect(parseAllowanceSet(set([path("/nix/store")], bad)).ok, String(bad)).toBe(false);
    expect(parseAllowanceSet(set([path("/nix/store")], 1800)).ok).toBe(true);
  });

  it("names the first entry that crosses the floor, by index, and a duplicate", () => {
    expect(parseAllowanceSet(set([path("/nix/store"), path("/home/ian"), domain("*.x.org")], 60))).toEqual({ ok: false, code: "path_home", index: 1 });
    expect(parseAllowanceSet(set([path("/nix/store"), path("/nix/store")], 60))).toMatchObject({ ok: false, code: "duplicate_entry" });
    // The index is the uploaded position of the later copy, not its place after sorting.
    expect(parseAllowanceSet(set([domain("z.example.com"), path("/nix/store"), domain("a.example.com"), domain("z.example.com")], 60))).toEqual({ ok: false, code: "duplicate_entry", index: 3 });
    // The same value with another access is another entry.
    expect(parseAllowanceSet(set([path("/tmp/x"), path("/tmp/x", "write")], 60)).ok).toBe(true);
  });

  it("refuses an unknown key, a non-object, a missing entries list and too many entries, and never repairs a value", () => {
    for (const bad of [null, "x", [], {}, { entries: "x" }, { entries: [], extra: 1 }, { entries: [{ ...path("/nix/store"), extra: 1 }], command_timeout_s: 60 }, { entries: [{ kind: "path", value: "/nix/store", access: "read" }], command_timeout_s: 60 }]) {
      expect(parseAllowanceSet(bad), JSON.stringify(bad)).toEqual({ ok: false, code: "invalid_shape", index: null });
    }
    const many = Array.from({ length: 65 }, (_, i) => domain(`h${i}.example.com`));
    expect(parseAllowanceSet(set(many, 60))).toEqual({ ok: false, code: "invalid_shape", index: null });
    expect(parseAllowanceSet(set([{ ...path("/nix/store"), value: " /nix/store" }], 60)).ok).toBe(false);
  });

  it("the signed job's schema is the same set, with entries required", () => {
    expect(JobAllowancesSchema.safeParse({ entries: [path("/nix/store")], command_timeout_s: 60 }).success).toBe(true);
    expect(JobAllowancesSchema.safeParse({ entries: [], command_timeout_s: 60 }).success).toBe(false);
  });
});

describe("the approved check (D#6 R-CHK-1, C47)", () => {
  const entry = { kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "pnpm install" } as const;
  const check = { argv: ["bash", "scripts/check.sh"], dev_shell: true, timeout_s: 5400 };
  const parse = (value: unknown) => parseAllowanceSet(value);
  const hashOf = (value: unknown): string => {
    const parsed = parse(value);
    if (!parsed.ok) throw new Error(`refused: ${parsed.code}`);
    return allowanceSetSha256(parsed.set);
  };

  // Computed outside this code base (Python, sorted keys, no whitespace), so a change to the canonical form shows up here.
  it("a set without a check hashes exactly as it did before checks existed", () => {
    expect(hashOf({ entries: [entry], command_timeout_s: 900 })).toBe("d9f767c666fc131ee4526914a84976166ead9066a6f0285fc282e0b8cf1905f8");
    expect(hashOf({ entries: [] })).toBe("d801aa1fb7ddcc330a5e3173372ea6af4a3d08ec58074478e85aa5603e926658");
    expect(hashOf({ entries: [entry], command_timeout_s: 900, check: null })).toBe(hashOf({ entries: [entry], command_timeout_s: 900 }));
  });

  it("the hash covers the check: two sets that differ only in it hash differently, and each matches the independent value", () => {
    expect(hashOf({ entries: [entry], command_timeout_s: 900, check })).toBe("72ad24435642d5836acafdfcebdb5a4364bfb893a31c93e8a63867a6b1b441a2");
    expect(hashOf({ entries: [], check })).toBe("4fee82872f42ab7fd550cdce6cd6b7012d0d6fd934219657c07105f220874dbe");
    for (const changed of [{ ...check, argv: ["bash", "scripts/check.sh", "--fast"] }, { ...check, dev_shell: false }, { ...check, timeout_s: 5401 }]) {
      expect(hashOf({ entries: [entry], command_timeout_s: 900, check: changed })).not.toBe(hashOf({ entries: [entry], command_timeout_s: 900, check }));
    }
  });

  it("keeps a check on a set with no entries, and a null check parses to a set without the key", () => {
    expect(parse({ entries: [], check })).toEqual({ ok: true, set: { entries: [], check } });
    expect(parse({ entries: [], check: null })).toEqual({ ok: true, set: { entries: [] } });
  });

  it("its time cap is its own: 5400 s is a check, and still not a command timeout", () => {
    expect(MAX_CHECK_TIMEOUT_S).toBe(10800);
    expect(MAX_COMMAND_TIMEOUT_S).toBe(1800);
    expect(parse({ entries: [], check }).ok).toBe(true);
    expect(parse({ entries: [entry], command_timeout_s: 5400 }).ok).toBe(false);
    for (const [timeout, accepted] of [[59, false], [60, true], [10800, true], [10801, false], [90.5, false], [0, false]] as const) {
      expect(parse({ entries: [], check: { ...check, timeout_s: timeout } }).ok, String(timeout)).toBe(accepted);
    }
  });

  it("takes an argument vector of 1 to 16 printable ASCII strings of 1 to 256 characters, and nothing else", () => {
    const argv = (value: unknown) => parse({ entries: [], check: { ...check, argv: value } }).ok;
    expect(argv(Array.from({ length: 16 }, () => "a"))).toBe(true);
    expect(argv(["x".repeat(256)])).toBe(true);
    expect(argv(["bash", "-c", "pnpm test && pnpm lint"])).toBe(true);
    for (const bad of [[], Array.from({ length: 17 }, () => "a"), [""], ["x".repeat(257)], ["a\0b"], ["a\nb"], ["a\rb"], ["a\tb"], ["café"], ["a‮b"], ["a\u007fb"], [1], "bash scripts/check.sh", null, [null]]) {
      expect(argv(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("is strict: an unknown key, a missing field or a wrong type is invalid_shape", () => {
    for (const bad of [{ ...check, extra: 1 }, { argv: check.argv, dev_shell: true }, { ...check, dev_shell: "yes" }, { ...check, timeout_s: "5400" }, "x", []]) {
      expect(parse({ entries: [], check: bad }), JSON.stringify(bad)).toEqual({ ok: false, code: "invalid_shape", index: null });
    }
  });
});
