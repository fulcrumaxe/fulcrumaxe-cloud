import { describe, expect, it } from "vitest";
import { parseTarget } from "../src/pathTarget.js";

describe("parseTarget", () => {
  it("parses a bare /repos/{owner}/{repo}", () => {
    expect(parseTarget("/repos/acme/widgets")).toEqual({
      kind: "api",
      owner: "acme",
      repo: "widgets",
      subpath: "",
    });
  });

  it("parses /repos/{owner}/{repo}/{subpath...}", () => {
    expect(parseTarget("/repos/acme/widgets/pulls/5/merge")).toEqual({
      kind: "api",
      owner: "acme",
      repo: "widgets",
      subpath: "/pulls/5/merge",
    });
  });

  it("parses git-upload-pack with the .git suffix", () => {
    expect(parseTarget("/acme/widgets.git/git-upload-pack")).toEqual({
      kind: "git",
      owner: "acme",
      repo: "widgets",
      service: "upload-pack",
      endpoint: "git-upload-pack",
    });
  });

  it("parses git-upload-pack without the .git suffix", () => {
    expect(parseTarget("/acme/widgets/git-upload-pack")).toEqual({
      kind: "git",
      owner: "acme",
      repo: "widgets",
      service: "upload-pack",
      endpoint: "git-upload-pack",
    });
  });

  it("parses git-receive-pack", () => {
    expect(parseTarget("/acme/widgets.git/git-receive-pack")).toEqual({
      kind: "git",
      owner: "acme",
      repo: "widgets",
      service: "receive-pack",
      endpoint: "git-receive-pack",
    });
  });

  it("disambiguates info/refs via ?service=git-upload-pack", () => {
    expect(parseTarget("/acme/widgets.git/info/refs", { service: "git-upload-pack" })).toEqual({
      kind: "git",
      owner: "acme",
      repo: "widgets",
      service: "upload-pack",
      endpoint: "info/refs",
    });
  });

  it("disambiguates info/refs via ?service=git-receive-pack", () => {
    expect(parseTarget("/acme/widgets.git/info/refs", { service: "git-receive-pack" })).toEqual({
      kind: "git",
      owner: "acme",
      repo: "widgets",
      service: "receive-pack",
      endpoint: "info/refs",
    });
  });

  it("returns null for info/refs with no service query", () => {
    expect(parseTarget("/acme/widgets.git/info/refs")).toBeNull();
  });

  it("returns null for info/refs with an unrecognized service value", () => {
    expect(parseTarget("/acme/widgets.git/info/refs", { service: "bogus" })).toBeNull();
  });

  it("returns null for a top-level path that matches neither shape", () => {
    expect(parseTarget("/gists")).toBeNull();
    expect(parseTarget("/user")).toBeNull();
    expect(parseTarget("/orgs/acme")).toBeNull();
    expect(parseTarget("/search/issues")).toBeNull();
  });
});
