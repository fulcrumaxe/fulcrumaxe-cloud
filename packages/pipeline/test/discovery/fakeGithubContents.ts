import type { ContentsRequester } from "../../src/discovery/verifierCites.js";

/**
 * A fake of GitHub's "get repository content" endpoint that answers like the real one, as far as our reader can touch it:
 *   - only `GET /repos/{owner}/{repo}/contents/{path}` of the repository it holds (another repo is 404);
 *   - the object media type must be asked for (415 otherwise). A file answers `type: "file"` with base64 content wrapped at 60
 *     characters; a DIRECTORY answers 200 with `type: "dir"` and its entries, each with a `download_url` carrying a `?token=`
 *     (as for a private repository); a SUBMODULE answers 200 `type: "submodule"`; a SYMLINK answers 200 `type: "symlink"` with its
 *     target and a tokened `download_url`. None of these is a 404, which is what hid the directory case before;
 *   - a file over 1 MB answers `encoding: "none"` with empty content, as the real API does between 1 and 100 MB;
 *   - `ref` must be present; this fake holds commits by full sha only and answers 404 for any other ref (the real API also takes
 *     branch names, but the reader under test must always pin a sha);
 *   - the path must be percent-encoded: a raw space, `#`, `?` or `%` not part of an escape is 400, as on the wire;
 *   - a missing path at that commit is 404.
 * What it cannot fake: rate limits, files over 100 MB (the real API answers 403; our reader sees a failed read either way), GitHub's
 * own path normalisation, and the exact metadata fields beyond those our reader looks at. A request that overruns `maxBytes` in the
 * real client throws; here the oversize answer above is what such a file looks like on the wire.
 */
export type FakeEntry = string | { symlink: string } | { submodule: string };

export interface FakeContents {
  request: ContentsRequester;
  /** Every request seen, in order: path and ref. */
  log: Array<{ path: string; ref: string }>;
}

const TOKEN = "?token=AFAKETOKEN123";
const wrap = (b64: string): string => (b64.match(/.{1,60}/g) ?? []).join("\n") + "\n";

export function fakeGithubContents(repo: { owner: string; name: string }, commits: Record<string, Record<string, FakeEntry>>): FakeContents {
  const log: FakeContents["log"] = [];
  const request: ContentsRequester = async (req) => {
    if (req.method !== "GET") return { status: 405, text: "" };
    log.push({ path: req.path, ref: req.query.ref });
    const prefix = `/repos/${repo.owner}/${repo.name}/contents/`;
    if (!req.path.startsWith(prefix)) return { status: 404, text: "" };
    if (req.accept !== "application/vnd.github.object+json") return { status: 415, text: "" };
    if (typeof req.query.ref !== "string" || req.query.ref === "") return { status: 400, text: "" };
    const encoded = req.path.slice(prefix.length);
    if (/[ #?]|%(?![0-9A-Fa-f]{2})/.test(encoded)) return { status: 400, text: "" };
    const files = commits[req.query.ref];
    if (files === undefined) return { status: 404, text: "" };
    const path = decodeURIComponent(encoded);
    const meta = (p: string, type: string) => ({ type, name: p.split("/").pop(), path: p, sha: "f".repeat(40), url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${p}` });
    const entry = Object.hasOwn(files, path) ? files[path] : undefined;
    if (entry === undefined) {
      const below = Object.keys(files).filter((k) => k.startsWith(`${path}/`));
      if (below.length === 0) return { status: 404, text: "" };
      const children = [...new Set(below.map((k) => k.slice(path.length + 1).split("/")[0]!))];
      return {
        status: 200,
        text: JSON.stringify({
          ...meta(path, "dir"),
          download_url: null,
          entries: children.map((c) => ({ ...meta(`${path}/${c}`, "file"), download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${req.query.ref}/${path}/${c}${TOKEN}` })),
        }),
      };
    }
    if (typeof entry !== "string") {
      return "symlink" in entry
        ? { status: 200, text: JSON.stringify({ ...meta(path, "symlink"), target: entry.symlink, download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${req.query.ref}/${path}${TOKEN}` }) }
        : { status: 200, text: JSON.stringify({ ...meta(path, "submodule"), submodule_git_url: entry.submodule, download_url: null }) };
    }
    const size = Buffer.byteLength(entry, "utf8");
    const download_url = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${req.query.ref}/${path}${TOKEN}`;
    if (size > 1024 * 1024) return { status: 200, text: JSON.stringify({ ...meta(path, "file"), size, encoding: "none", content: "", download_url }) };
    return { status: 200, text: JSON.stringify({ ...meta(path, "file"), size, encoding: "base64", content: wrap(Buffer.from(entry, "utf8").toString("base64")), download_url }) };
  };
  return { request, log };
}
