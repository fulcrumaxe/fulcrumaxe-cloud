import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLinkPolicy, persistGateReport, runPublishGates, scanLeaks } from "../src/index.js";

const dirs: string[] = [];
async function site(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "k06-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), body);
  }
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const page = (inner: string) => `<html><body>${inner}</body></html>`;

// Plants are assembled at runtime so no secret-shaped literal sits in the repo.
const PLANTS: Record<string, string> = {
  aws_access_key: "AKIA" + "ABCDEFGHIJKLMNOP",
  aws_secret_key: "aws_secret_access_key=" + "A".repeat(40),
  gcp_api_key: "AIza" + "B".repeat(35),
  azure_storage_key: "AccountKey=" + "C".repeat(44),
  github_token: "ghp_" + "d".repeat(36),
  stripe_live_key: "sk_live_" + "e".repeat(24),
  slack_token: "xoxb-" + "1234567890-abcdef",
  api_key_sk: "sk-" + "f".repeat(30),
  private_key: "-----BEGIN RSA PRIV" + "ATE KEY-----",
  jwt: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3"].join("."),
  private_ip: "10.1.2.3",
  private_hostname: "build.corp",
  email_not_allowlisted: "jane.doe@gmail.example",
  deny_list: "Project Nightjar",
};

describe("leak scan (K06 criterion 1)", () => {
  it.each(Object.entries(PLANTS))("blocks a %s in rendered HTML", async (kind, plant) => {
    const dir = await site({ "index.html": page(`<p>${plant}</p>`) });
    const res = await scanLeaks(dir, { denyList: ["project nightjar"] });
    expect(res.ok).toBe(false);
    expect(res.findings.map((f) => f.kind)).toContain(kind);
    expect(res.findings[0].path).toBe("/index.html");
  });

  it.each(["private_ip", "aws_access_key", "deny_list"])("blocks a %s that appears only in site.json", async (kind) => {
    const dir = await site({ "index.html": page("<p>clean</p>") });
    const res = await scanLeaks(dir, { denyList: ["project nightjar"], siteJson: { note: PLANTS[kind] } });
    expect(res.ok).toBe(false);
    expect(res.findings.find((f) => f.kind === kind)?.path).toBe("/site.json");
  });

  it("blocks a secret in a JSON or text asset, not just HTML", async () => {
    const dir = await site({ "index.html": page("ok"), "assets/config.json": `{"k":"${PLANTS.github_token}"}`, "robots.txt": PLANTS.private_ip });
    const res = await scanLeaks(dir);
    expect(res.findings.map((f) => f.path).sort()).toEqual(["/assets/config.json", "/robots.txt"]);
  });

  it("passes a clean site, and passes allowlisted emails by address or by domain", async () => {
    const dir = await site({ "index.html": page("<a href='mailto:hello@acme.example'>a</a> team@acme.example img@2x.png 8.8.8.8") });
    expect((await scanLeaks(dir, { emailAllowlist: ["hello@acme.example", "@acme.example"] })).ok).toBe(true);
    const blocked = await scanLeaks(dir);
    expect(blocked.findings.map((f) => f.kind)).toEqual(["email_not_allowlisted", "email_not_allowlisted"]);
  });

  it.each(["secrets.yml", ".env", "notes.md", "data.csv", "deploy/Dockerfile", ".well-known/config"])(
    "scans %s, whatever its name",
    async (name) => {
      const dir = await site({ "index.html": page("ok"), [name]: `key: ${PLANTS.github_token}\n` });
      const res = await scanLeaks(dir);
      expect(res.ok).toBe(false);
      expect(res.findings.find((f) => f.kind === "github_token")?.path).toBe("/" + name);
    },
  );

  it("reports a skipped binary as advisory and an oversized or non-regular file as an error", async () => {
    const dir = await site({
      "index.html": page("ok"),
      "logo.png": "\u0089PNG\u0000\u0000" + PLANTS.github_token,
      "huge.log": "a".repeat(5 * 1024 * 1024 + 1),
    });
    await symlink("index.html", path.join(dir, "link.html"));
    const res = await scanLeaks(dir);
    const skipped = res.findings.filter((f) => f.kind === "unscanned_file").map((f) => [f.path, f.severity]);
    expect(skipped).toEqual([["/link.html", "error"], ["/huge.log", "error"], ["/logo.png", "advisory"]]);
    expect(res.summary).toMatchObject({ filesScanned: 1, filesSkipped: 3 });
    const onlyBinary = await site({ "index.html": page("ok"), "logo.png": "\u0000\u0001" });
    expect((await scanLeaks(onlyBinary)).ok).toBe(true);
  });

  it.each(["10.1.2.3", "192.168.0.1", "172.16.0.1", "127.0.0.1", "169.254.1.1", "0.0.0.0", "::1", "[::1]:8080", "fd12:3456::1", "fe80::1"])(
    "blocks the private address %s",
    async (ip) => {
      const res = await scanLeaks(await site({ "index.html": page(`<p>host ${ip} end</p>`) }));
      expect(res.findings.map((f) => f.kind)).toEqual(["private_ip"]);
    },
  );

  it("rejects an empty or empty-matching deny-list entry instead of blocking everything", async () => {
    const dir = await site({ "index.html": page("ok") });
    for (const entry of ["", /x*/, /(?:)/g]) await expect(scanLeaks(dir, { denyList: [entry] })).rejects.toThrow(/denyList/);
  });

  it("never puts the full secret value into a finding", async () => {
    const dir = await site({ "index.html": page(PLANTS.github_token) });
    const res = await scanLeaks(dir);
    expect(JSON.stringify(res)).not.toContain(PLANTS.github_token);
  });

  it("does not treat public addresses or ordinary hostnames as private", async () => {
    const dir = await site({ "index.html": page("172.32.0.1 11.0.0.1 example.com docs.acme.example") });
    expect((await scanLeaks(dir)).ok).toBe(true);
  });
});

describe("outbound link policy (K06 criterion 2)", () => {
  const html = page(
    `<a href="/about">in</a><a href="https://acme.example/x">own</a>` +
      `<a href='https://partner.example/a?b=1#frag'>p</a><a href=https://other.example/z>o</a>` +
      `<script src="//cdn.example/x.js"></script><a href="mailto:a@b.example">m</a>`,
  );

  it("blocks every outbound link to a foreign host until approved", async () => {
    const dir = await site({ "index.html": html });
    const res = await checkLinkPolicy(dir, { siteDomains: ["acme.example"] });
    expect(res.ok).toBe(false);
    expect(res.findings.map((f) => f.subject).sort()).toEqual([
      "https://cdn.example/x.js",
      "https://other.example/z",
      "https://partner.example/a?b=***",
    ]);
  });

  it("approval is per link: approving one leaves the others blocking", async () => {
    const dir = await site({ "index.html": html });
    const res = await checkLinkPolicy(dir, { siteDomains: ["acme.example"], approvedLinks: ["https://partner.example/a?b=1#other-fragment"] });
    expect(res.findings).toHaveLength(2);
    expect(res.findings.some((f) => f.message.includes("partner.example"))).toBe(false);
  });

  it("passes when every outbound link is approved, and when there are none", async () => {
    const dir = await site({ "index.html": html });
    const all = ["https://partner.example/a?b=1", "https://other.example/z", "https://cdn.example/x.js"];
    expect((await checkLinkPolicy(dir, { siteDomains: ["acme.example"], approvedLinks: all })).ok).toBe(true);
    const none = await site({ "index.html": page('<a href="/x">x</a>') });
    expect((await checkLinkPolicy(none)).ok).toBe(true);
  });
});

const TOKEN = "ghp_" + "Z".repeat(36);
const PASSWORD = "hunter2pw";

describe("link secrets stay out of the report (MUST 1)", () => {
  const url = `https://user:${PASSWORD}@partner.example/cb?token=${TOKEN}&x=1#frag`;
  it("masks userinfo and query values in findings and pendingLinks, whole report serialised", async () => {
    const dir = await site({ "index.html": page(`<a href="${url}">p</a>`) });
    const rep = await runPublishGates(dir);
    const json = JSON.stringify(rep);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain(TOKEN);
    expect(rep.pendingLinks).toEqual(["https://***@partner.example/cb?token=***&x=***"]);
  });

  it("still matches approval against the full URL in memory", async () => {
    const dir = await site({ "index.html": page(`<a href="${url}">p</a>`) });
    expect((await checkLinkPolicy(dir, { approvedLinks: [url] })).ok).toBe(true);
    const other = `https://user:${PASSWORD}@partner.example/cb?token=different`;
    expect((await checkLinkPolicy(dir, { approvedLinks: [other] })).ok).toBe(false);
  });
});

describe("link parsing fails closed (MUST 3)", () => {
  const kindsOf = async (inner: string, opts = {}) =>
    (await checkLinkPolicy(await site({ "index.html": page(inner) }), opts)).findings.map((f) => f.kind);

  it.each(["&#58;", "&colon;", "&#x3A;"])("decodes %s in the scheme separator and flags the foreign host", async (colon) => {
    const res = await checkLinkPolicy(await site({ "index.html": page(`<a href="https${colon}//evil.example/x">x</a>`) }));
    expect(res.findings.map((f) => f.subject)).toEqual(["https://evil.example/x"]);
  });

  it("decodes an entity-encoded approved URL the same way for approval", async () => {
    const dir = await site({ "index.html": page(`<a href="https&#58;//p.example/a?b=1&amp;c=2">x</a>`) });
    expect((await checkLinkPolicy(dir, { approvedLinks: ["https://p.example/a?b=1&c=2"] })).ok).toBe(true);
  });

  it.each(["javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "JaVa&#09;Script:alert(1)", "  javascript:alert(1)"])(
    "flags %s as an error",
    async (href) => {
      expect(await kindsOf(`<a href="${href}">x</a>`)).toEqual(["disallowed_link_scheme"]);
    },
  );

  it.each(["&constructor;", "&toString;", "&hasOwnProperty;", "&valueOf;"])("treats the inherited name %s as an unknown entity, not a decodable one", async (ref) => {
    expect(await kindsOf(`<a href="https${ref}//a.example">x</a>`)).toEqual(["unparseable_link"]);
  });

  it("leaves &__proto__; alone: it is not an entity reference at all (no letters-only name), so it never reaches the lookup", async () => {
    expect(await kindsOf(`<a href="https&__proto__;//a.example">x</a>`)).toEqual([]);
  });

  it("flags an href that does not parse, and an unknown entity, instead of dropping them", async () => {
    expect(await kindsOf(`<a href="https://">x</a>`)).toEqual(["unparseable_link"]);
    expect(await kindsOf(`<a href="https&bogus;//a.example">x</a>`)).toEqual(["unparseable_link"]);
  });

  it("treats a backslash-led or protocol-relative value as an outbound host", async () => {
    expect(await kindsOf(`<a href="/\\evil.example/x">x</a><a href="//evil2.example">y</a>`)).toEqual([
      "unapproved_outbound_link",
      "unapproved_outbound_link",
    ]);
  });

  it.each([
    ["srcset (every candidate)", `<img srcset="/a.png 1x, https://one.example/b.png 2x, https://two.example/c.png 3x">`, ["one.example", "two.example"]],
    ["formaction", `<button formaction="https://form.example/go">x</button>`, ["form.example"]],
    ["object data", `<object data="https://obj.example/f.swf"></object>`, ["obj.example"]],
    ["meta refresh", `<meta http-equiv="refresh" content="0; url=https://meta.example/y">`, ["meta.example"]],
  ])("checks %s", async (_name, inner, hosts) => {
    const res = await checkLinkPolicy(await site({ "index.html": page(inner) }));
    expect(res.findings.map((f) => new URL(f.subject ?? "").hostname).sort()).toEqual(hosts);
  });

  it("does not put the raw value of a rejected link into the report", async () => {
    const dir = await site({ "index.html": page(`<a href="javascript:fetch('/x?k=${TOKEN}')">x</a><a href="https://:${PASSWORD}@/">y</a>`) });
    const json = JSON.stringify(await runPublishGates(dir));
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(PASSWORD);
  });
});

describe("gate report (K06 criterion 3)", () => {
  it("combines both gates, lists pending links, and blocks on either", async () => {
    const dir = await site({ "index.html": page(`<a href="https://partner.example/a">p</a>`) });
    const rep = await runPublishGates(dir);
    expect(rep).toMatchObject({ version: 1, ok: false, pendingLinks: ["https://partner.example/a"] });
    const clean = await runPublishGates(dir, { approvedLinks: ["https://partner.example/a"] });
    expect(clean.ok).toBe(true);
    const leaky = await runPublishGates(dir, { approvedLinks: ["https://partner.example/a"], siteJson: PLANTS.private_ip });
    expect(leaky).toMatchObject({ ok: false, pendingLinks: [] });
  });

  it("stores the report under site_versions.report without replacing other keys", async () => {
    const dir = await site({ "index.html": page("ok") });
    const rep = await runPublishGates(dir);
    const calls: { text: string; values: unknown[] }[] = [];
    await persistGateReport({ query: async (text, values) => (calls.push({ text, values }), { rowCount: 1 }) }, "v-1", rep);
    expect(calls[0].text).toMatch(/UPDATE site_versions SET report = COALESCE\(report, '\{\}'::jsonb\) \|\| jsonb_build_object\('publishGates'/);
    expect(calls[0].values).toEqual(["v-1", JSON.stringify(rep)]);
    await expect(persistGateReport({ query: async () => ({ rowCount: 0 }) }, "v-2", rep)).rejects.toThrow(/v-2/);
  });
});
