import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { EngineArchiveRefused, MAX_ARCHIVE_BYTES, MAX_HOPS, MAX_TAR_BYTES, engineFile, fetchEngineArchive, type EngineResponse, type EngineTransport } from "../../src/setup/engineArchive.js";
import { engineTgz, tgzOf } from "../helpers/tarBuilder.js";
import { redirectTo, sendBytes, startEngineHttps, type EngineHttps, type Route } from "../helpers/engineHttps.js";

/** D#845 ON-8c criterion: the engine archive is fetched over real TLS (a local server), every redirect hop is re-checked, the body is capped and hashed, and the tar is read entry by entry. */
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const URL_OK = "https://codeload.github.com/acme/engine/tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PATH_OK = "/acme/engine/tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let server: EngineHttps | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});
async function serve(routes: Record<string, Route>): Promise<EngineHttps> {
  server = await startEngineHttps(routes);
  return server;
}
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EngineArchiveRefused);
    return (error as EngineArchiveRefused).message;
  }
  throw new Error("expected a refusal");
}
const release = (bytes: Buffer, url = URL_OK) => ({ tarball_url: url, tarball_sha256: sha(bytes) });

describe("a good archive", () => {
  it("is fetched through the github.com to codeload.github.com redirect, hashed, unpacked and read", async () => {
    const bytes = engineTgz();
    const s = await serve({ "github.com/acme/engine/archive/v1.tar.gz": redirectTo(URL_OK), [`codeload.github.com${PATH_OK}`]: sendBytes(bytes) });
    const got = await fetchEngineArchive(release(bytes, "https://github.com/acme/engine/archive/v1.tar.gz"), { transport: s.transport });
    expect(got.sha256).toBe(sha(bytes));
    expect(s.seen.map((r) => r.host)).toEqual(["github.com", "codeload.github.com"]);
    expect(engineFile(got.entries, "scripts/coldstart-templates/epic/epic.md")?.toString()).toContain("## Context");
  });

  it("takes exactly the allowed number of redirects and no more", async () => {
    const bytes = engineTgz();
    const hops = Array.from({ length: MAX_HOPS }, (_, i) => `/h${i}`);
    const routes: Record<string, Route> = { [`codeload.github.com${PATH_OK}`]: redirectTo(`https://codeload.github.com${hops[0]}`) };
    hops.forEach((h, i) => (routes[`codeload.github.com${h}`] = i === hops.length - 1 ? sendBytes(bytes) : redirectTo(`https://codeload.github.com${hops[i + 1]}`)));
    const s = await serve(routes);
    expect((await fetchEngineArchive(release(bytes), { transport: s.transport })).sha256).toBe(sha(bytes));
    // one more hop is one too many
    const endless: Record<string, Route> = {};
    for (let i = 0; i <= MAX_HOPS + 1; i++) endless[`codeload.github.com${i === 0 ? PATH_OK : `/e${i}`}`] = redirectTo(`https://codeload.github.com/e${i + 1}`);
    await server?.close();
    const t = await serve(endless);
    expect(await refusal(fetchEngineArchive(release(bytes), { transport: t.transport }))).toBe("engine_fetch_failed:hops");
  });
});

describe("hosts", () => {
  it("a redirect to another host is refused before any request is made to it", async () => {
    const bytes = engineTgz();
    const s = await serve({ [`codeload.github.com${PATH_OK}`]: redirectTo("https://evil.example.com/engine.tgz") });
    expect(await refusal(fetchEngineArchive(release(bytes), { transport: s.transport }))).toBe("engine_archive_refused:host");
    expect(s.seen).toHaveLength(1);
  });

  it("a redirect to a look-alike, a port, credentials or plain http is refused; a spy transport sees no second call", async () => {
    const bytes = engineTgz();
    for (const location of ["https://codeload.github.com.evil.example/x", "https://codeload.github.com:8443/x", "https://user:pw@codeload.github.com/x", "http://codeload.github.com/x", "https://raw.githubusercontent.com/x", "//evil.example/x"]) {
      let calls = 0;
      const transport: EngineTransport = async () => {
        calls++;
        return { status: 302, location, body: (async function* () {})(), close: () => undefined } satisfies EngineResponse;
      };
      expect(await refusal(fetchEngineArchive(release(bytes), { transport })), location).toBe("engine_archive_refused:host");
      expect(calls, location).toBe(1);
    }
  });

  it("a start URL the cloud signed on another host never reaches the transport", async () => {
    let calls = 0;
    const transport: EngineTransport = async () => (calls++, { status: 200, body: (async function* () {})(), close: () => undefined });
    expect(await refusal(fetchEngineArchive({ tarball_url: "https://evil.example.com/a/b", tarball_sha256: "0".repeat(64) }, { transport }))).toBe("engine_archive_refused:host");
    expect(calls).toBe(0);
  });

  it("a status that is not 200 is a failed fetch", async () => {
    const s = await serve({});
    expect(await refusal(fetchEngineArchive(release(Buffer.from("x")), { transport: s.transport }))).toBe("engine_fetch_failed:status");
  });
});

describe("size and hash", () => {
  it("a declared length over the cap is refused before a byte is read", async () => {
    let read = false;
    const transport: EngineTransport = async () => ({ status: 200, contentLength: MAX_ARCHIVE_BYTES + 1, body: (async function* () { read = true; yield Buffer.alloc(1); })(), close: () => undefined });
    expect(await refusal(fetchEngineArchive({ tarball_url: URL_OK, tarball_sha256: "0".repeat(64) }, { transport }))).toBe("engine_archive_refused:too_large");
    expect(read).toBe(false);
  });

  it("a body that streams past the cap with no declared length is cut off at the cap, over real TLS", async () => {
    const chunk = Buffer.alloc(1024 * 1024);
    const s = await serve({
      [`codeload.github.com${PATH_OK}`]: async (response) => {
        // no content-length: chunked, a megabyte at a time, until the client hangs up
        for (let i = 0; i < MAX_ARCHIVE_BYTES / chunk.length + 8 && !response.destroyed; i++) if (!response.write(chunk)) await new Promise<void>((resolve) => { const done = (): void => { response.off("drain", done); response.off("close", done); resolve(); }; response.once("drain", done); response.once("close", done); });
        response.end();
      },
    });
    expect(await refusal(fetchEngineArchive({ tarball_url: URL_OK, tarball_sha256: "0".repeat(64) }, { transport: s.transport }))).toBe("engine_archive_refused:too_large");
  }, 60_000);

  it("a tampered archive is engine_checksum, and nothing is read from it", async () => {
    const good = engineTgz();
    const tampered = engineTgz([{ name: "engine-abc/evil.sh", body: "rm -rf /\n" }]);
    const s = await serve({ [`codeload.github.com${PATH_OK}`]: sendBytes(tampered) });
    expect(await refusal(fetchEngineArchive(release(good), { transport: s.transport }))).toBe("engine_checksum:mismatch");
  });

  it("the hash is checked before the bytes are decompressed: a mismatching bomb is a checksum failure, not a decompression", async () => {
    const bomb = gzipSync(Buffer.alloc(MAX_TAR_BYTES + 1));
    const s = await serve({ [`codeload.github.com${PATH_OK}`]: sendBytes(bomb) });
    expect(await refusal(fetchEngineArchive({ tarball_url: URL_OK, tarball_sha256: "f".repeat(64) }, { transport: s.transport }))).toBe("engine_checksum:mismatch");
  });
});

describe("the archive itself", () => {
  async function refusedFor(bytes: Buffer): Promise<string> {
    const s = await serve({ [`codeload.github.com${PATH_OK}`]: sendBytes(bytes) });
    const text = await refusal(fetchEngineArchive(release(bytes), { transport: s.transport }));
    await s.close();
    server = undefined;
    return text;
  }

  it("refuses path traversal, an absolute path and a .git entry", async () => {
    expect(await refusedFor(tgzOf([{ name: "engine-abc/../../etc/cron.d/x", body: "x" }]))).toBe("engine_archive_refused:path");
    expect(await refusedFor(tgzOf([{ name: "/etc/passwd", body: "x" }]))).toBe("engine_archive_refused:path");
    expect(await refusedFor(tgzOf([{ name: "engine-abc/.git/config", body: "x" }]))).toBe("engine_archive_refused:path");
  });

  it("refuses a symlink out of the tree, an absolute symlink, a hard link and a device", async () => {
    expect(await refusedFor(tgzOf([{ name: "engine-abc/l", type: "2", link: "../../outside" }]))).toBe("engine_archive_refused:link");
    expect(await refusedFor(tgzOf([{ name: "engine-abc/l", type: "2", link: "/etc/shadow" }]))).toBe("engine_archive_refused:link");
    expect(await refusedFor(tgzOf([{ name: "engine-abc/a", body: "x" }, { name: "engine-abc/h", type: "1", link: "engine-abc/a" }]))).toBe("engine_archive_refused:link");
    expect(await refusedFor(tgzOf([{ name: "engine-abc/dev", type: "3" }]))).toBe("engine_archive_refused:type");
  });

  it("refuses a set-id file, and a body that is not gzip or not a tar", async () => {
    expect(await refusedFor(tgzOf([{ name: "engine-abc/su", body: "x", mode: 0o4755 }]))).toBe("engine_archive_refused:mode");
    expect(await refusedFor(Buffer.from("not gzip at all"))).toBe("engine_archive_refused:gzip");
    expect(await refusedFor(gzipSync(Buffer.from("this is gzip but it is not a tar archive, padded".padEnd(1024, "x"))))).toBe("engine_archive_refused:malformed");
  });

  it("refuses a gzip that expands past the cap", async () => {
    expect(await refusedFor(gzipSync(Buffer.alloc(MAX_TAR_BYTES + 1)))).toBe("engine_archive_refused:gzip");
  }, 60_000);
});
