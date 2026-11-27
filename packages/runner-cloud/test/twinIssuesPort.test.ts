import { describe, expect, it } from "vitest";
import { FROM_PUBLIC_LABEL, localOnlyViolation } from "../src/localOnlyGithub.js";
import { RunPullRequestError, createRunPullRequestPort, type PullRequestRepo } from "../src/runPullRequest.js";
import { broughtBody, broughtTitle } from "../src/twinIssues.js";
import { FAKE_APP_LOGIN, FakeGithub, installationKindClient, openInstallationKinds } from "./helpers/githubFake.js";

/**
 * D#845 ON-27f (A33, A34, A35): bringing one public issue into the twin. The fence entries, the port calls over the strict fake and the live `setup_labels` path list,
 * and the text of the copy. Real GitHub also makes a label on first use when an issue names it; the fake stores the names, so a missing label is not a case it can show.
 */
const PUBLIC: PullRequestRepo = { id: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const PRIVATE: PullRequestRepo = { id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "widgets-private" };
const reasonOf = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as RunPullRequestError | null)?.reason;
function setup() {
  const fake = new FakeGithub();
  const pub = fake.addRepo("acme", "widgets");
  const priv = fake.addRepo("acme", "widgets-private", { id: 7654321 });
  const asked: Array<string | undefined> = [];
  const open = openInstallationKinds(fake);
  const port = createRunPullRequestPort({ open: async (r, purpose) => (asked.push(purpose), open(r, purpose)), appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
  return { fake, pub, priv, port, asked };
}
const issue = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, title: `Issue ${n}`, body: `Body ${n}`, labels: [], state: "open" as const, author: { login: `user${n}`, type: "User" as const }, ...extra });

describe("A33 to A35 on the fence", () => {
  const list = (query: Record<string, string>, path = "/repos/acme/widgets/issues") => ({ method: "GET", path, query });
  const copy = { title: "T", body: "B", labels: [FROM_PUBLIC_LABEL] };
  it("lets a setupInstall client list the open issues, read one and open the one copy", () => {
    expect(localOnlyViolation(list({ state: "open", per_page: "100" }), [], { setupInstall: true })).toBeNull();
    expect(localOnlyViolation(list({ state: "open" }), [], { setupInstall: true })).toBeNull();
    expect(localOnlyViolation({ method: "GET", path: "/repos/acme/widgets/issues/7" }, [], { setupInstall: true })).toBeNull();
    expect(localOnlyViolation({ method: "POST", path: "/repos/acme/widgets/issues", body: copy }, [], { setupInstall: true })).toBeNull();
  });
  it("refuses a list that is not exactly the open issues, a copy that is not exactly title, body and the one label, and every other client", () => {
    for (const q of [{}, { state: "closed" }, { state: "all" }, { state: "open", labels: "x" }, { state: "open", per_page: "0" }, { state: "open", per_page: "101" }] as Array<Record<string, string>>) expect(localOnlyViolation(list(q), [], { setupInstall: true }), JSON.stringify(q)).toBe("not_allowlisted");
    expect(localOnlyViolation(list({ state: "open" }, "/repos/acme/widgets/issues?state=open"), [], { setupInstall: true })).toBe("not_allowlisted");
    for (const body of [{ ...copy, labels: ["bug"] }, { ...copy, labels: [FROM_PUBLIC_LABEL, "bug"] }, { ...copy, assignees: ["x"] }, { title: "T", body: "B" }, { ...copy, title: "" }, { ...copy, title: "a\nb" }, { ...copy, body: "x".repeat(65_537) }, { ...copy, body: 1 }, null, undefined]) {
      expect(localOnlyViolation({ method: "POST", path: "/repos/acme/widgets/issues", body }, [], { setupInstall: true }), JSON.stringify(body)?.slice(0, 40)).toBe("not_allowlisted");
    }
    for (const p of ["/repos/acme/widgets/issues/7/comments", "/repos/acme/widgets/issues/x"]) expect(localOnlyViolation({ method: "GET", path: p }, [], { setupInstall: true }), p).toBe("not_allowlisted");
    for (const method of ["PATCH", "PUT", "DELETE"]) expect(localOnlyViolation({ method, path: "/repos/acme/widgets/issues/7", body: { state: "closed" } }, [], { setupInstall: true }), method).toBe("not_allowlisted");
    for (const options of [{}, { setupFinish: true }, { gate1Attest: true }, { engineRemove: true }]) {
      expect(localOnlyViolation({ method: "GET", path: "/repos/acme/widgets/issues/7" }, [], options), JSON.stringify(options)).toBe("not_allowlisted");
      expect(localOnlyViolation({ method: "POST", path: "/repos/acme/widgets/issues", body: copy }, [], options), JSON.stringify(options)).toBe("not_allowlisted");
    }
  });
  it("leaves the finish phase's own issue calls (A28, A29) as they were: the team-log label, and the team-log body, on a setupFinish client", () => {
    expect(localOnlyViolation(list({ labels: "team-log", state: "open", per_page: "30" }), [], { setupFinish: true })).toBeNull();
    expect(localOnlyViolation(list({ state: "open" }), [], { setupFinish: true })).toBe("not_allowlisted");
  });
});

describe("the port: listOpenIssues, readIssue, createBroughtIssue", () => {
  it("lists the newest open issues first, drops pull requests and closed ones, cuts to the limit, and shows number, title and author login only", async () => {
    const { fake, pub, port, asked } = setup();
    pub.issues.push(issue(1), issue(2, { pull_request: true }), issue(3, { state: "closed" }), issue(4), issue(5), issue(6, { author: { login: "carol", type: "User" } }));
    const got = await port.listOpenIssues({ repo: PUBLIC, limit: 3 });
    expect(got).toEqual([{ number: 6, title: "Issue 6", author: "carol" }, { number: 5, title: "Issue 5", author: "user5" }, { number: 4, title: "Issue 4", author: "user4" }]);
    expect(asked).toEqual(["issue_read"]);
    expect(fake.denied).toBe(0);
    expect(fake.calls.map((c) => [c.method, c.path, c.query])).toEqual([["GET", "/repos/acme/widgets/issues", { state: "open", per_page: 100 }]]);
  });

  it("reads one issue in full; a pull request reads as a pull request; a number with nothing behind it is null; a closed issue reads as closed", async () => {
    const { pub, port } = setup();
    pub.issues.push(issue(1, { body: "hello" }), issue(2, { pull_request: true }), issue(3, { state: "closed" }));
    expect(await port.readIssue({ repo: PUBLIC, number: 1 })).toEqual({ number: 1, title: "Issue 1", author: "user1", body: "hello", open: true, pull: false });
    expect((await port.readIssue({ repo: PUBLIC, number: 2 }))?.pull).toBe(true);
    expect((await port.readIssue({ repo: PUBLIC, number: 3 }))?.open).toBe(false);
    expect(await port.readIssue({ repo: PUBLIC, number: 99 })).toBeNull();
    for (const number of [0, -1, 1.5, Number.NaN]) expect(await reasonOf(port.readIssue({ repo: PUBLIC, number })), String(number)).toBe("malformed");
  });

  it("opens the copy in the private repository with the one label and answers its number; the public repository is untouched", async () => {
    const { fake, pub, priv, port } = setup();
    const n = await port.createBroughtIssue({ repo: PRIVATE, title: "T", body: "B" });
    expect(priv.issues).toEqual([{ number: n, title: "T", body: "B", labels: [FROM_PUBLIC_LABEL], state: "open" }]);
    expect(pub.issues).toEqual([]);
    expect(fake.denied).toBe(0);
  });

  it("through the pull request kind alone the same calls are refused path_refused, and nothing is read or made", async () => {
    const fake = new FakeGithub();
    const pub = fake.addRepo("acme", "widgets");
    pub.issues.push(issue(1));
    const port = createRunPullRequestPort({ open: async () => installationKindClient(fake, "runner_pr"), appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
    expect(await reasonOf(port.listOpenIssues({ repo: PUBLIC, limit: 20 }))).toBe("unavailable");
    expect(await reasonOf(port.createBroughtIssue({ repo: PUBLIC, title: "T", body: "B" }))).toBe("unavailable");
    expect(fake.denied).toBe(2);
    expect(pub.issues).toHaveLength(1);
  });

  it("least privilege: the public repository is read through the read-only client alone and the one copy is opened through the twin_issue client alone; neither can do the other's call", async () => {
    const { fake, pub, port, asked } = setup();
    pub.issues.push(issue(1));
    await port.listOpenIssues({ repo: PUBLIC, limit: 5 });
    await port.readIssue({ repo: PUBLIC, number: 1 });
    await port.createBroughtIssue({ repo: PRIVATE, title: "T", body: "B" });
    expect(asked).toEqual(["issue_read", "issue_read", "twin_issue"]);
    const read = installationKindClient(fake, "issue_read");
    const write = installationKindClient(fake, "twin_issue");
    await expect(read.request({ method: "POST", path: "/repos/acme/widgets-private/issues", body: { title: "T", body: "B", labels: [FROM_PUBLIC_LABEL] } })).rejects.toThrow(/path_refused/);
    for (const req of [{ method: "GET", path: "/repos/acme/widgets/issues", query: { state: "open" } }, { method: "GET", path: "/repos/acme/widgets/issues/1" }, { method: "POST", path: "/repos/acme/widgets-private/labels", body: { name: "a", color: "000000", description: "d" } }, { method: "POST", path: "/repos/acme/widgets-private/issues", body: { title: "T", body: "B", labels: ["bug"] } }]) {
      await expect(write.request(req), JSON.stringify(req).slice(0, 60)).rejects.toThrow(/path_refused/);
    }
  });

  it("a malformed answer is malformed, an error status is unavailable or rejected, and every client is closed once whatever the answer", async () => {
    const { fake, pub, port } = setup();
    pub.issues.push(issue(1));
    fake.inject = { label: /A28/, reply: { status: 200, body: { not: "a list" } } };
    expect(await reasonOf(port.listOpenIssues({ repo: PUBLIC, limit: 20 }))).toBe("malformed");
    fake.inject = { label: /A28/, reply: { status: 503, body: { message: "down" } } };
    expect(await reasonOf(port.listOpenIssues({ repo: PUBLIC, limit: 20 }))).toBe("unavailable");
    fake.inject = { label: /A29/, reply: { status: 403, body: { message: "Resource not accessible by integration" } } };
    expect(await reasonOf(port.createBroughtIssue({ repo: PRIVATE, title: "T", body: "B" }))).toBe("rejected");
    fake.inject = { label: /A34/, reply: { status: 200, body: { number: 5, title: "x", state: "open" } } };
    expect(await reasonOf(port.readIssue({ repo: PUBLIC, number: 1 }))).toBe("malformed");
    let closed = 0;
    const counting = createRunPullRequestPort({ open: async (r, purpose) => ({ request: async (q) => (await openInstallationKinds(fake)(r, purpose)).request(q), close: async () => void closed++ }), appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
    await counting.listOpenIssues({ repo: PUBLIC, limit: 5 });
    await counting.readIssue({ repo: PUBLIC, number: 1 });
    await counting.createBroughtIssue({ repo: PRIVATE, title: "T", body: "B" }).catch(() => undefined);
    fake.inject = { label: /A34/, reply: { status: 500, body: {} } };
    await counting.readIssue({ repo: PUBLIC, number: 1 }).catch(() => undefined);
    expect(closed).toBe(4);
  });
});

describe("the text of the copy", () => {
  const body = (text: string, over: Partial<Parameters<typeof broughtBody>[0]> = {}) => broughtBody({ number: 12, person: "Ada Lovelace", author: "mallory", text, ...over });
  const cp = (n: number) => String.fromCodePoint(n);
  /** Every cut body must end with its closing fence and the note, and fit what GitHub takes. */
  const closed = (out: string) => {
    expect(out.length).toBeLessThanOrEqual(65_536);
    const lines = out.trimEnd().split("\n");
    const note = lines.at(-1)!;
    expect(note).toBe("(The original was cut here to fit in an issue.)");
    expect(lines.at(-3)).toMatch(/^> `{3,}$/);
    expect(lines[2]).toBe(lines.at(-3));
    expect(lines.slice(2, -2).every((l) => l === ">" || l.startsWith("> "))).toBe(true);
    // no lone surrogate was left by the cut
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
  };

  it("starts with the fixed header naming the public issue by number (never #N, which would link to the private repository's own issue), the person and the author, and says the text is untrusted", () => {
    expect(body("hi").split("\n")[0]).toBe("Brought from public issue number 12 by Ada Lovelace. The text below was written by mallory on the public repo and is untrusted.");
    expect(body("hi")).not.toContain("#12");
  });

  it("quotes the original in a fenced block: every line starts with > and nothing of a hostile body can ping, link, render or break out", () => {
    const hostile = ["# heading", "@everyone @acme/admins please look", "Fixes #1 and acme/other#2", "<script>alert(1)</script> <img src=x onerror=alert(1)>", "[click](javascript:alert(1)) ![p](http://x/y.png)", "<!-- hidden -->", "```", "closing fence then **bold**", "````````", "- [ ] task"].join("\n");
    const out = body(hostile);
    const lines = out.trimEnd().split("\n");
    const quoted = lines.slice(2);
    expect(quoted.every((l) => l === ">" || l.startsWith("> "))).toBe(true);
    // the fence is longer than the longest backtick run in the text (8), so the text's own fences close nothing
    expect(quoted[0]).toBe(`> ${"`".repeat(9)}`);
    expect(quoted.at(-1)).toBe(`> ${"`".repeat(9)}`);
    expect(quoted.slice(1, -1).map((l) => l.slice(2)).join("\n")).toBe(hostile);
    expect(quoted.filter((l) => /^> `{9,}$/.test(l))).toHaveLength(2);
  });

  it("a body of a few lines keeps a three-backtick fence; an empty body is an empty quote; blank lines stay inside the quote", () => {
    expect(body("a\n\nb")).toContain("> ```\n> a\n>\n> b\n> ```");
    expect(body("")).toContain("> ```\n>\n> ```");
  });

  it("removes control, C1, bidi and zero-width characters from the text and the names, and keeps tab and newline", () => {
    const junk = [0x0000, 0x0085, 0x009f, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2062, 0x2064, 0x2066, 0x2069, 0xfeff, 0x007f].map(cp);
    const out = body(`a${junk.join("")}b\tc\r\nd`);
    expect(out).toContain("> ab\tc\n> d\n");
    for (const ch of junk) expect(out.includes(ch), `U+${ch.codePointAt(0)!.toString(16)}`).toBe(false);
    expect(body("x", { person: "Eve <b>@all</b>\n# x", author: "bad login!" }).split("\n")[0]).toBe("Brought from public issue number 12 by Eve ballb x. The text below was written by an unknown user on the public repo and is untrusted.");
    expect(body("x", { person: "" }).split("\n")[0]).toContain(" by a team member.");
  });

  it("the whole body, header, prefixes, fences and note included, is at most 65,536 characters: a body that fits exactly is whole and unmarked, and one more character is cut and marked with the fence still closed", () => {
    const base = body("").length;
    // one line: an empty text is one ">" line, a text of n characters is "> " and n: a body of base + n + 1
    const fits = body("a".repeat(65_536 - base - 1));
    expect(fits.length).toBe(65_536);
    expect(fits).not.toContain("was cut here");
    const over = body("a".repeat(65_536 - base));
    closed(over);
    expect(over).toContain("> " + "a".repeat(100));
  });

  it("a text of 64 KiB of newlines (every line gets a prefix and the body triples) and one of ordinary lines near the old limit are cut to fit, never over", () => {
    closed(body("\n".repeat(65_536)));
    closed(body("0123456789abcdef\n".repeat(4_200)));
    // text just inside 64 KiB of UTF-8 but long in prefixes: still bounded
    closed(body("x\n".repeat(32_000)));
  });

  it("cuts on a code-point boundary: a multi-byte or astral character at the cut is whole or gone, and the fence, closed, follows the cut text (a backtick run that is cut away no longer lengthens the fence)", () => {
    const base = body("").length;
    for (const ch of ["é", "€", cp(0x1f600), cp(0x10000)]) {
      for (let extra = 0; extra < 4; extra++) {
        const text = "a".repeat(65_536 - base - 3 + extra) + ch.repeat(3);
        const out = body(text);
        closed(out);
        expect(out.length).toBeLessThanOrEqual(65_536);
      }
    }
    // multi-byte text past 64 KiB of UTF-8 is cut at the byte limit on a character boundary, with no replacement character
    const long = body("é".repeat(40_000));
    closed(long);
    expect(long).not.toContain("�");
    // a long backtick run at the very end of the text is cut away with its piece: the fence is chosen after the cut
    const tail = body("a".repeat(65_536 - base - 5) + "`".repeat(200));
    closed(tail);
    expect(tail.split("\n")[2]!.length).toBeLessThan(40);
  });

  it("FU-324: an emoji (an astral character, two UTF-16 units) at the cut point is kept whole or dropped whole at every offset, never half: no lone surrogate, the fence closed, the note present, the body within the cap", () => {
    const base = body("").length;
    const emoji = cp(0x1f600);
    let cutSeen = 0;
    for (let pad = 0; pad < 12; pad++) {
      // the text fills the room exactly up to pad units short of the cap, then emoji follow: the cut falls inside, before or after an emoji as pad moves
      const text = "a".repeat(65_536 - base - 8 - pad) + emoji.repeat(10);
      const out = body(text);
      closed(out);
      const quote = out.trimEnd().split("\n").slice(3, -3).join("\n");
      const emojis = quote.split(emoji).length - 1;
      expect(quote.replace(/> /g, "").replace(/\n/g, "").replaceAll(emoji, "").replace(/a/g, ""), `pad ${pad}`).toBe("");
      expect(emojis).toBeLessThan(10);
      cutSeen++;
    }
    expect(cutSeen).toBe(12);
    // a text of emoji alone, cut by the 64 KiB byte limit and by the character limit, stays whole characters
    const onlyEmoji = body(emoji.repeat(40_000));
    closed(onlyEmoji);
    expect(onlyEmoji).not.toContain("\uFFFD");
    expect(Array.from(onlyEmoji.trimEnd().split("\n").slice(3, -3).join("").replace(/> /g, "")).every((c) => c === emoji)).toBe(true);
  });

  it("the title is the public title, cut by UTF-16 length to the 256 the fence allows without splitting a pair, with every control character, a tab too, made a space and bidi and zero-width marks removed", () => {
    expect(broughtTitle("  Same title  ")).toBe("Same title");
    expect(broughtTitle("x".repeat(400))).toHaveLength(256);
    const astral = broughtTitle(cp(0x1f600).repeat(300));
    expect(astral.length).toBe(256);
    expect([...astral]).toHaveLength(128);
    expect(broughtTitle("a" + cp(0x1f600).repeat(300)).length).toBe(255);
    expect(broughtTitle("Crash\tin\tstart")).toBe("Crash in start");
    expect(broughtTitle("a\u0007b\nc" + cp(0x202e) + "d" + cp(0x200b) + "e")).toBe("a b cde");
    expect(broughtTitle("\u0000\n")).toBe("(no title)");
    for (const t of ["Crash\tin\tstart", cp(0x1f600).repeat(300), "x".repeat(400)]) expect(localOnlyViolation({ method: "POST", path: "/repos/acme/widgets/issues", body: { title: broughtTitle(t), body: "B", labels: [FROM_PUBLIC_LABEL] } }, [], { setupInstall: true }), t.slice(0, 10)).toBeNull();
  });

  it("every body it builds is accepted by the fence (A35) and by the strict fake's issue create, which both hold the 65,536 limit", () => {
    for (const text of ["", "hello", "\n".repeat(70_000), "é".repeat(70_000), "`".repeat(70_000), "x".repeat(200_000)]) {
      const out = body(text);
      expect(out.length, text.slice(0, 5)).toBeLessThanOrEqual(65_536);
      expect(localOnlyViolation({ method: "POST", path: "/repos/acme/widgets/issues", body: { title: "T", body: out, labels: [FROM_PUBLIC_LABEL] } }, [], { setupInstall: true })).toBeNull();
    }
    const fake = new FakeGithub();
    fake.addRepo("acme", "widgets");
    return expect(Promise.resolve().then(() => fake.request({ method: "POST", path: "/repos/acme/widgets/issues", headers: { accept: "application/vnd.github+json" }, body: { title: "T", body: "x".repeat(65_537), labels: [FROM_PUBLIC_LABEL] } }))).rejects.toThrow(/65536/);
  });
});
