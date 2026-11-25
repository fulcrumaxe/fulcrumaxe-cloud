import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATE1_QUEUE_DOCUMENTS, GITHUB_GRAPHQL_DOCUMENTS, LOCAL_ONLY_ALLOWLIST, SETUP_INSTALL_DOCUMENTS, SETUP_INSTALL_LABELS, localOnlyGithub, localOnlyViolation, type GithubClient, type GithubRequest } from "../src/localOnlyGithub.js";

/**
 * D#845 ON-8f2a (A25): the one extra read of the install step, the parents of one commit. It holds on a client built with `setupInstall` and on no other: not the default client, not the attester's, not the
 * engine removal's. The document selects commit ids and a count and nothing else of a commit.
 */
const here = dirname(fileURLToPath(import.meta.url));
const sha = "c".repeat(40);
const body = (variables: Record<string, unknown>, query: string = SETUP_INSTALL_DOCUMENTS.CommitParents) => ({ query, variables });
const good = { owner: "acme", name: "widgets", sha };
const call = (b: unknown): Pick<GithubRequest, "method" | "path" | "body"> => ({ method: "POST", path: "/graphql", body: b });

describe("A25 CommitParents", () => {
  it("is allowed on a setupInstall client, with exactly owner, name and a full commit id", () => {
    expect(localOnlyViolation(call(body(good)), [], { setupInstall: true })).toBeNull();
    for (const bad of [{ ...good, extra: 1 }, { owner: "acme", name: "widgets" }, { ...good, sha: "c".repeat(39) }, { ...good, sha: "refs/heads/main" }, { ...good, sha: "C".repeat(40) }, { ...good, owner: ".." }, { ...good, sha: 1 }]) {
      expect(localOnlyViolation(call(body(bad as Record<string, unknown>)), [], { setupInstall: true }), JSON.stringify(bad)).toBe("not_allowlisted");
    }
  });

  it("is refused on every other client: the default one, the attester's, the read-only status client and the engine removal's", () => {
    expect(localOnlyViolation(call(body(good)))).toBe("not_allowlisted");
    expect(localOnlyViolation(call(body(good)), [], { gate1Attest: true })).toBe("not_allowlisted");
    expect(localOnlyViolation(call(body(good)), [], { gate1Status: true })).toBe("not_allowlisted");
    expect(localOnlyViolation(call(body(good)), [], { engineRemove: true })).toBe("not_allowlisted");
  });

  it("opening it does not open the attester's entries, and the attester's client does not open it", () => {
    expect(localOnlyViolation({ method: "POST", path: "/repos/acme/widgets/issues/1/labels", body: { labels: ["ci:full"] } }, [], { setupInstall: true })).toBe("not_allowlisted");
    expect(localOnlyViolation(call(body(good, GATE1_QUEUE_DOCUMENTS.Gate1QueueEntries)), [], { setupInstall: true })).toBe("not_allowlisted");
  });

  it("takes only the fixed text: another document, an edited one and a document that asks for more are refused", () => {
    for (const query of [GITHUB_GRAPHQL_DOCUMENTS.RunBranchState, `${SETUP_INSTALL_DOCUMENTS.CommitParents} `, SETUP_INSTALL_DOCUMENTS.CommitParents.replace("parents(first: 5)", "parents(first: 100)"), SETUP_INSTALL_DOCUMENTS.CommitParents.replace("oid", "oid message")]) {
      expect(localOnlyViolation(call(body(good, query)), [], { setupInstall: true })).toBe("not_allowlisted");
    }
  });

  it("selects commit ids and a count, no message, author, tree, file or patch", () => {
    const doc = SETUP_INSTALL_DOCUMENTS.CommitParents;
    for (const word of ["message", "author", "committer", "tree", "blob", "file", "patch", "diff", "text", "body", "history"]) expect(doc, word).not.toMatch(new RegExp(`\\b${word}\\b`));
  });

  it("goes through the wrapper's graphql(op) by name on that client only, and the A25 entry is the only opt-in entry of its kind", async () => {
    const seen: GithubRequest[] = [];
    const inner: GithubClient = { request: async (r) => (seen.push(r), { status: 200, body: {} }) };
    await localOnlyGithub(inner, { setupInstall: true }).graphql("CommitParents", good);
    expect(seen).toHaveLength(1);
    await expect(localOnlyGithub(inner).graphql("CommitParents", good)).rejects.toMatchObject({ rule: "not_allowlisted" });
    expect(seen).toHaveLength(1);
    expect(LOCAL_ONLY_ALLOWLIST.filter((e) => e.only === "setupInstall").map((e) => e.id)).toEqual(["A25", "A26", "A30"]);
  });
});

/**
 * D#845 ON-8f2b (A26): creating one of the engine's 11 labels, on a `setupInstall` client only, with exactly one table row as the body.
 */
describe("A26 create a label", () => {
  const path = "/repos/acme/widgets/labels";
  const row = SETUP_INSTALL_LABELS[0]!;
  const make = (body: unknown, p = path, method = "POST") => ({ method, path: p, body });

  it("the table holds the engine's 11 labels with GitHub-valid names, colours and descriptions", () => {
    expect(SETUP_INSTALL_LABELS).toHaveLength(11);
    expect(new Set(SETUP_INSTALL_LABELS.map((l) => l.name.toLowerCase())).size).toBe(11);
    for (const l of SETUP_INSTALL_LABELS) {
      expect(l.name.length).toBeGreaterThanOrEqual(1);
      expect(l.name.length).toBeLessThanOrEqual(50);
      expect(l.color).toMatch(/^[0-9A-F]{6}$/);
      expect([...l.description].length).toBeLessThanOrEqual(100);
    }
  });

  // The engine's own script is the source of the table. It is an engine tool that is not part of the public files, so this runs where the script is installed (the team's checkout) and is skipped, by name, where it is not.
  const script = [resolve(here, "../../../scripts/bootstrap-github-labels.sh")].find((p) => existsSync(p));
  it.skipIf(script === undefined)("equals what the installed bootstrap script creates, row for row", () => {
    const text = readFileSync(script!, "utf8");
    const parsed = [...text.matchAll(/^create_label\s+"([^"]+)"\s+"([0-9A-Fa-f]{6})"\s+"([^"]*)"/gm)].map((m) => ({ name: m[1]!, color: m[2]!, description: m[3]! }));
    expect(parsed).toHaveLength(11);
    expect(parsed).toEqual(SETUP_INSTALL_LABELS.map((l) => ({ ...l })));
  });

  it("allows exactly one table row on a setupInstall client, whichever row", () => {
    for (const l of SETUP_INSTALL_LABELS) expect(localOnlyViolation(make({ name: l.name, color: l.color, description: l.description }), [], { setupInstall: true }), l.name).toBeNull();
  });

  it("refuses a row that is not exactly a table row: another name, a changed colour or words, a leading #, extra or missing keys, an array, a second label", () => {
    const bad = [
      { name: "bug", color: "0E8A16", description: row.description },
      { ...row, color: "000000" },
      { ...row, color: `#${row.color}` },
      { ...row, color: row.color.toLowerCase() },
      { ...row, description: `${row.description} ` },
      { ...row, name: row.name.toUpperCase() },
      { ...row, extra: 1 },
      { name: row.name, color: row.color },
      { name: SETUP_INSTALL_LABELS[0]!.name, color: SETUP_INSTALL_LABELS[1]!.color, description: SETUP_INSTALL_LABELS[0]!.description },
      [row],
      { labels: [row.name] },
      null,
      undefined,
      "x",
    ];
    for (const body of bad) expect(localOnlyViolation(make(body), [], { setupInstall: true }), JSON.stringify(body)).toBe("not_allowlisted");
  });

  it("is refused on every other client, and the setupInstall client holds no other label call", () => {
    for (const options of [{}, { gate1Attest: true }, { gate1Status: true }, { engineRemove: true }]) expect(localOnlyViolation(make(row), [], options), JSON.stringify(options)).toBe("not_allowlisted");
    for (const p of ["/repos/acme/widgets/labels/bug", "/repos/acme/widgets/issues/1/labels", "/repos/acme/widgets/labels?per_page=1", "/repos/acme/widgets/labels/x/y", "/repos/../widgets/labels"]) {
      expect(localOnlyViolation(make(row, p), [], { setupInstall: true }), p).toBe("not_allowlisted");
    }
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) expect(localOnlyViolation(make(row, path, method), [], { setupInstall: true }), method).toBe("not_allowlisted");
  });

  it("goes through the wrapper once and only for a table row", async () => {
    const seen: GithubRequest[] = [];
    const inner: GithubClient = { request: async (r) => (seen.push(r), { status: 201, body: {} }) };
    const gh = localOnlyGithub(inner, { setupInstall: true });
    await gh.request({ method: "POST", path, body: { ...row } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers).toMatchObject({ accept: "application/vnd.github+json" });
    await expect(gh.request({ method: "POST", path, body: { ...row, name: "other" } })).rejects.toMatchObject({ rule: "not_allowlisted" });
    expect(seen).toHaveLength(1);
  });
});
