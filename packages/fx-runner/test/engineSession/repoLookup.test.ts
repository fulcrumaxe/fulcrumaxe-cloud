import { symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepoLookup } from "../../src/engineSession/repoLookup.js";
import { tempDir } from "../helpers/tempTree.js";
import { git, hostDeps } from "../vm/workspace/helpers.js";

/** D#845 ON-13a1: who a repository id is comes only from this machine's own mirror, and only in the one plain https shape. */
function mirrorWith(origin: string | undefined): { lookup: (id: number) => Promise<{ owner: string; name: string } | undefined>; root: string } {
  const root = tempDir("fx-lookup-");
  const dir = path.join(root, "77.git");
  git(root, "init", "-q", "--bare", dir);
  if (origin !== undefined) git(dir, "remote", "add", "origin", origin);
  return { lookup: createRepoLookup({ git: hostDeps().git, mirrorDir: (id) => path.join(root, `${String(id)}.git`) }), root };
}

describe("the repository lookup", () => {
  it("reads the owner and name from the mirror's recorded origin", async () => {
    expect(await mirrorWith("https://github.com/acme/Widgets.Service.git").lookup(77)).toEqual({ owner: "acme", name: "Widgets.Service" });
  });

  it.each([
    ["no origin", undefined],
    ["ssh", "git@github.com:acme/widgets.git"],
    ["plain http", "http://github.com/acme/widgets.git"],
    ["another host", "https://example.test/acme/widgets.git"],
    ["credentials", "https://user:pw@github.com/acme/widgets.git"],
    ["a port", "https://github.com:8443/acme/widgets.git"],
    ["a query", "https://github.com/acme/widgets.git?x=1"],
    ["no .git", "https://github.com/acme/widgets"],
    ["a nested path", "https://github.com/acme/widgets/extra.git"],
    ["an owner that starts with a dash", "https://github.com/-acme/widgets.git"],
    ["a dotted name", "https://github.com/acme/...git"],
    ["a local path", "/srv/fixture/widgets.git"],
  ])("answers nothing for %s", async (_name, origin) => {
    expect(await mirrorWith(origin).lookup(77)).toBeUndefined();
  });

  it("answers nothing for an id this machine has no mirror of, and for a mirror that is a link", async () => {
    const m = mirrorWith("https://github.com/acme/widgets.git");
    expect(await m.lookup(78)).toBeUndefined();
    symlinkSync(path.join(m.root, "77.git"), path.join(m.root, "79.git"));
    expect(await m.lookup(79)).toBeUndefined();
  });
});
