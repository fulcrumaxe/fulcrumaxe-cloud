import { afterEach, describe, expect, it } from "vitest";
import { FetchRefusal, MAX_REDIRECTS, PinnedFetcher } from "../../src/update/pinnedFetcher.js";
import { buildRepo, makeKeys } from "../fixtures/tufRepo.js";
import { startTufServer, type TufServer } from "../fixtures/tufServer.js";

/** The fetcher alone: it asks for nothing outside the two configured locations, and only over https. */

let server: TufServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function up(): Promise<{ server: TufServer; fetcher: PinnedFetcher }> {
  server = await startTufServer(buildRepo({ root: { version: 1, keys: makeKeys() }, targets: [{ path: "v1/a", content: Buffer.from("a") }] }));
  return { server, fetcher: new PinnedFetcher({ allowedBases: [server.metadataBase, server.targetBase], ca: server.ca }) };
}

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

describe("what the fetcher will ask for", () => {
  it("fetches under a configured base", async () => {
    const { fetcher } = await up();
    expect(await readAll(await fetcher.fetch(`${server!.targetBase}v1/a`))).toBe("a");
  });

  it("refuses another path on the same origin, another origin, another scheme and an address with credentials, without any request", async () => {
    const { fetcher } = await up();
    const port = new URL(server!.originA).port;
    for (const url of [
      `${server!.originA}/other/v1/a`,
      `${server!.originA}/targets-evil/v1/a`,
      `${server!.originB}/files/v1/a`,
      `http://127.0.0.1:${port}/targets/v1/a`,
      `https://user:pw@127.0.0.1:${port}/targets/v1/a`,
      `${server!.originA}/targets/../other/x`,
      "not an address",
    ]) {
      await expect(fetcher.fetch(url), url).rejects.toMatchObject({ code: "url_not_allowed" });
    }
    expect(server!.requests).toEqual([]);
  });

  it("a base address must be a plain https URL", () => {
    for (const base of ["http://example.invalid/m/", "https://u:p@example.invalid/m/", "https://example.invalid/m/?q=1", "https://example.invalid/m/#f", "nope"]) {
      expect(() => new PinnedFetcher({ allowedBases: [base] }), base).toThrow(FetchRefusal);
    }
  });

  it("gives up after the redirect limit", async () => {
    const { fetcher } = await up();
    server!.redirects.set("/targets/loop", `${server!.originA}/targets/loop`);
    await expect(fetcher.fetch(`${server!.targetBase}loop`)).rejects.toMatchObject({ code: "redirect_refused" });
    expect(server!.requests.length).toBe(MAX_REDIRECTS + 1);
  });

  it("follows a relative redirect that stays under the base, and a redirect out to another https origin", async () => {
    const { fetcher } = await up();
    server!.redirects.set("/targets/rel", "/targets/v1/a");
    expect(await readAll(await fetcher.fetch(`${server!.targetBase}rel`))).toBe("a");
    server!.files.set("v1/b", Buffer.from("b"));
    server!.redirects.set("/targets/out", `${server!.originB}/files/v1/b`);
    expect(await readAll(await fetcher.fetch(`${server!.targetBase}out`))).toBe("b");
  });
});
