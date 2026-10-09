import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isFullCloneRequest, parseUploadPackRequest } from "../src/parseUploadPack.js";
import { concatBytes, encodeFlushPkt, encodePktLine, SHA_A, SHA_B } from "./fixtures.js";
import { startRealGit, type CapturedPost, type RealGit } from "./realGitUploadPack.js";

const BRANCHES = 40;
const enc = (s: string) => new TextEncoder().encode(s);
const DELIM = enc("0001");

/** What each real git command sent, split by the command that sent it. */
const captured: Record<string, CapturedPost[]> = {};
let rg: RealGit;

async function capture(name: string, fn: () => Promise<unknown>): Promise<void> {
  const before = rg.posts.length;
  await fn();
  captured[name] = rg.posts.slice(before);
}

beforeAll(async () => {
  rg = await startRealGit();
  const work = `${rg.root}/work`;
  await rg.git(["init", "-q", "-b", "main", work]);
  await rg.git(["config", "uploadpack.allowFilter", "true"], rg.source);
  await rg.git(["config", "uploadpack.allowAnySHA1InWant", "true"], rg.source);
  const commit = async (msg: string) => {
    await rg.git(["commit", "-q", "--allow-empty", "-m", msg], work);
  };
  await commit("root");
  for (let i = 0; i < BRANCHES; i++) {
    await rg.git(["checkout", "-q", "-B", `topic-${i}`, "main"], work);
    await commit(`topic ${i}`);
  }
  await rg.git(["checkout", "-q", "main"], work);
  await rg.git(["push", "-q", rg.source, "--all"], work);

  const clone = (dest: string, ...extra: string[]) => rg.git(["clone", "-q", ...extra, rg.url, `${rg.root}/${dest}`]);
  await capture("v2-small", () => clone("c-small", "--single-branch", "--branch", "main"));
  await capture("v2-all", () => clone("c-all"));
  await capture("v2-shallow", () => clone("c-shallow", "--depth", "1", "--single-branch", "--branch", "main"));
  await capture("v2-filter", () => clone("c-filter", "--filter=blob:none", "--single-branch", "--branch", "main"));
  await capture("v0-small", () => clone("c-v0", "-c", "protocol.version=0", "--single-branch", "--branch", "main"));

  // Move every branch forward in the source so the next fetches have something to negotiate.
  for (let i = 0; i < BRANCHES; i++) {
    await rg.git(["checkout", "-q", `topic-${i}`], work);
    await commit(`topic ${i} again`);
  }
  await rg.git(["checkout", "-q", "main"], work);
  await commit("main again");
  await rg.git(["push", "-q", rg.source, "--all"], work);
  await capture("v2-update", () => rg.git(["fetch", "-q", "origin"], `${rg.root}/c-all`));
  await capture("v0-update", () => rg.git(["fetch", "-q", "origin"], `${rg.root}/c-v0`));
}, 120_000);

afterAll(async () => {
  await rg?.close();
});

const parseAll = (name: string) => captured[name]!.map((p) => parseUploadPackRequest(p.inflated));

describe("parseUploadPackRequest against the real git", () => {
  it("v2 clone of one branch: ls-refs, then a fetch with a want and no have (a full clone)", () => {
    const [lsRefs, fetch] = parseAll("v2-small");
    expect(captured["v2-small"]!.every((p) => p.protocol.includes("version=2"))).toBe(true);
    expect(lsRefs).toMatchObject({ complete: true, command: "ls-refs", wants: [], haves: [] });
    expect(isFullCloneRequest(lsRefs!)).toBe(false);
    expect(fetch!.complete).toBe(true);
    expect(fetch!.command).toBe("fetch");
    expect(fetch!.wants).toHaveLength(1);
    expect(fetch!.haves).toEqual([]);
    expect(isFullCloneRequest(fetch!)).toBe(true);
  });

  it("v2 clone of every branch is gzipped by git (over 1 KiB); the inflated body parses as a clone, the raw one does not", () => {
    const fetchPost = captured["v2-all"]!.find((p) => parseUploadPackRequest(p.inflated).command === "fetch")!;
    expect(fetchPost.gzipped).toBe(true);
    expect(fetchPost.inflated.length).toBeGreaterThan(1024);
    const parsed = parseUploadPackRequest(fetchPost.inflated);
    expect(parsed.complete).toBe(true);
    expect(parsed.wants.length).toBeGreaterThan(BRANCHES);
    expect(parsed.haves).toEqual([]);
    expect(isFullCloneRequest(parsed)).toBe(true);
    // Not inflated: refused, never read as "not a clone".
    const raw = parseUploadPackRequest(fetchPost.raw);
    expect(raw.complete).toBe(false);
    expect(isFullCloneRequest(raw)).toBe(false);
  });

  it("a shallow first fetch (no have) counts as a full clone", () => {
    const fetch = parseAll("v2-shallow").find((p) => p.command === "fetch")!;
    expect(fetch.complete).toBe(true);
    expect(fetch.haves).toEqual([]);
    expect(isFullCloneRequest(fetch)).toBe(true);
  });

  it("a filtered first fetch (no have) counts as a full clone", () => {
    const fetch = parseAll("v2-filter").find((p) => p.command === "fetch")!;
    expect(fetch.complete).toBe(true);
    expect(fetch.haves).toEqual([]);
    expect(isFullCloneRequest(fetch)).toBe(true);
  });

  it("a v2 fetch with have lines (gzipped, as git sends it) is not a clone", () => {
    const posts = captured["v2-update"]!;
    const fetchPost = posts.find((p) => parseUploadPackRequest(p.inflated).command === "fetch")!;
    expect(fetchPost.gzipped).toBe(true);
    const parsed = parseUploadPackRequest(fetchPost.inflated);
    expect(parsed.complete).toBe(true);
    expect(parsed.wants.length).toBeGreaterThan(0);
    expect(parsed.haves.length).toBeGreaterThan(0);
    expect(isFullCloneRequest(parsed)).toBe(false);
    const lsRefs = posts.map((p) => parseUploadPackRequest(p.inflated)).find((p) => p.command === "ls-refs")!;
    expect(lsRefs.complete).toBe(true);
    expect(isFullCloneRequest(lsRefs)).toBe(false);
  });

  it("v0 want list from the real git: wants with capabilities on the first line, no have, a clone", () => {
    const post = captured["v0-small"]![0]!;
    expect(post.protocol).not.toContain("version=2");
    const parsed = parseUploadPackRequest(post.inflated);
    expect(parsed.complete).toBe(true);
    expect(parsed.command).toBe("fetch");
    expect(parsed.wants).toHaveLength(1);
    expect(parsed.haves).toEqual([]);
    expect(isFullCloneRequest(parsed)).toBe(true);
  });

  it("v0 fetch with have lines is not a clone", () => {
    const parsed = parseAll("v0-update").find((p) => p.haves.length > 0)!;
    expect(parsed.complete).toBe(true);
    expect(parsed.wants.length).toBeGreaterThan(0);
    expect(isFullCloneRequest(parsed)).toBe(false);
  });

  it("every real request, cut short at any length, is incomplete or never claims more than was sent", () => {
    const bodies = Object.values(captured).flatMap((posts) => posts.map((p) => p.inflated));
    expect(bodies.length).toBeGreaterThan(8);
    for (const body of bodies) {
      for (const cut of [0, 1, 3, 4, 5, Math.floor(body.length / 2), body.length - 4, body.length - 1]) {
        if (cut < 0 || cut >= body.length) continue;
        const full = parseUploadPackRequest(body);
        const parsed = parseUploadPackRequest(body.subarray(0, cut));
        // A prefix that ends exactly on a v0 pkt boundary is a valid shorter v0 request only when it still
        // holds the closing flush-pkt; for v2 the closing flush-pkt is mandatory.
        if (parsed.complete) {
          expect(parsed.command).toBe("fetch");
          expect(parsed.wants.length).toBeLessThanOrEqual(full.wants.length);
        }
        expect(parsed.complete && full.command === "ls-refs").toBe(false);
      }
    }
  });
});

describe("parseUploadPackRequest framing rules", () => {
  const fetchV2 = (...args: string[]) =>
    concatBytes([
      encodePktLine("command=fetch\n"),
      encodePktLine("agent=git/2\n"),
      encodePktLine("object-format=sha1\n"),
      DELIM,
      ...args.map((a) => encodePktLine(`${a}\n`)),
      encodeFlushPkt(),
    ]);

  it("v2 fetch with a want and no have", () => {
    const parsed = parseUploadPackRequest(fetchV2(`want ${SHA_A}`, "thin-pack", "ofs-delta", "done"));
    expect(parsed).toEqual({ complete: true, command: "fetch", wants: [SHA_A], haves: [] });
  });

  it("v2 fetch with a want and a have", () => {
    const parsed = parseUploadPackRequest(fetchV2(`want ${SHA_A}`, `have ${SHA_B}`, "done"));
    expect(parsed).toEqual({ complete: true, command: "fetch", wants: [SHA_A], haves: [SHA_B] });
    expect(isFullCloneRequest(parsed)).toBe(false);
  });

  it("v2 fetch with no want at all is not a clone", () => {
    const parsed = parseUploadPackRequest(fetchV2("done"));
    expect(parsed.complete).toBe(true);
    expect(isFullCloneRequest(parsed)).toBe(false);
  });

  it("v2 want-ref counts as a want, so it cannot hide a clone", () => {
    const parsed = parseUploadPackRequest(fetchV2("want-ref refs/heads/main", "done"));
    expect(parsed.wants).toEqual(["refs/heads/main"]);
    expect(isFullCloneRequest(parsed)).toBe(true);
  });

  it("v2 ls-refs with and without arguments", () => {
    const withArgs = concatBytes([
      encodePktLine("command=ls-refs\n"),
      DELIM,
      encodePktLine("peel\n"),
      encodePktLine("ref-prefix refs/heads/\n"),
      encodeFlushPkt(),
    ]);
    expect(parseUploadPackRequest(withArgs)).toEqual({ complete: true, command: "ls-refs", wants: [], haves: [] });
    const bare = concatBytes([encodePktLine("command=ls-refs\n"), encodeFlushPkt()]);
    expect(parseUploadPackRequest(bare).complete).toBe(true);
  });

  it("an unknown v2 command is reported as other, never as a clone", () => {
    const parsed = parseUploadPackRequest(concatBytes([encodePktLine("command=object-info\n"), encodeFlushPkt()]));
    expect(parsed).toMatchObject({ complete: true, command: "other" });
    expect(isFullCloneRequest(parsed)).toBe(false);
  });

  it("only a fetch counts as a clone, even if another command carries a want line", () => {
    for (const command of ["ls-refs", "object-info"]) {
      const body = concatBytes([encodePktLine(`command=${command}\n`), DELIM, encodePktLine(`want ${SHA_A}\n`), encodeFlushPkt()]);
      const parsed = parseUploadPackRequest(body);
      expect(parsed).toMatchObject({ complete: true, wants: [SHA_A], haves: [] });
      expect(isFullCloneRequest(parsed)).toBe(false);
    }
  });

  it("refuses malformed v2 bodies", () => {
    // unterminated, trailing bytes after the flush, a second delim, a bad object id, a bare want-ref
    expect(parseUploadPackRequest(concatBytes([encodePktLine("command=fetch\n"), DELIM, encodePktLine(`want ${SHA_A}\n`)])).complete).toBe(false);
    expect(parseUploadPackRequest(concatBytes([fetchV2(`want ${SHA_A}`), enc("0000")])).complete).toBe(false);
    expect(parseUploadPackRequest(concatBytes([encodePktLine("command=fetch\n"), DELIM, DELIM, encodeFlushPkt()])).complete).toBe(false);
    expect(parseUploadPackRequest(fetchV2("want not-an-oid")).complete).toBe(false);
    expect(parseUploadPackRequest(fetchV2("want-ref ")).complete).toBe(false);
  });

  it("refuses bad framing and unknown first lines", () => {
    expect(parseUploadPackRequest(new Uint8Array())).toEqual({ complete: false, command: null, wants: [], haves: [] });
    expect(parseUploadPackRequest(enc("0000")).complete).toBe(false);
    expect(parseUploadPackRequest(enc("zzzz")).complete).toBe(false);
    expect(parseUploadPackRequest(enc("0004")).complete).toBe(false);
    expect(parseUploadPackRequest(enc("0003")).complete).toBe(false);
    expect(parseUploadPackRequest(enc("0002")).complete).toBe(false);
    expect(parseUploadPackRequest(encodePktLine("hello\n")).complete).toBe(false);
    expect(parseUploadPackRequest(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00])).complete).toBe(false);
  });

  it("v0: wants with capabilities, flush, haves and done", () => {
    const body = concatBytes([
      encodePktLine(`want ${SHA_A} multi_ack side-band-64k ofs-delta\n`),
      encodePktLine(`want ${SHA_B}\n`),
      encodePktLine("deepen 1\n"),
      encodeFlushPkt(),
      encodePktLine(`have ${SHA_B}\n`),
      encodePktLine("done\n"),
    ]);
    expect(parseUploadPackRequest(body)).toEqual({ complete: true, command: "fetch", wants: [SHA_A, SHA_B], haves: [SHA_B] });
  });

  it("v0: refuses a missing flush, capabilities on a later want, a bad have, and bytes after done", () => {
    const wants = [encodePktLine(`want ${SHA_A} ofs-delta\n`)];
    expect(parseUploadPackRequest(concatBytes(wants)).complete).toBe(false);
    expect(parseUploadPackRequest(concatBytes([...wants, encodePktLine(`want ${SHA_B} ofs-delta\n`), encodeFlushPkt()])).complete).toBe(false);
    expect(parseUploadPackRequest(concatBytes([...wants, encodeFlushPkt(), encodePktLine("have nope\n")])).complete).toBe(false);
    expect(parseUploadPackRequest(concatBytes([...wants, encodeFlushPkt(), encodePktLine("done\n"), encodePktLine(`have ${SHA_B}\n`)])).complete).toBe(false);
    expect(parseUploadPackRequest(concatBytes([...wants, encodePktLine("bogus line\n"), encodeFlushPkt()])).complete).toBe(false);
  });

  it("v0: a clone is a flushed want list with no have", () => {
    const body = concatBytes([encodePktLine(`want ${SHA_A}\n`), encodeFlushPkt(), encodePktLine("done\n")]);
    expect(isFullCloneRequest(parseUploadPackRequest(body))).toBe(true);
  });

  it("accepts SHA-256 object ids", () => {
    const oid = "a".repeat(64);
    expect(parseUploadPackRequest(fetchV2(`want ${oid}`)).wants).toEqual([oid]);
  });
});
