import { describe, expect, it } from "vitest";
import { isValidRefName } from "../src/refName.js";

describe("isValidRefName", () => {
  it.each(["refs/heads/fx/H03", "refs/heads/fx/cool-feature", "refs/heads/main", "refs/tags/v1.0.0"])(
    "accepts %s",
    (ref) => {
      expect(isValidRefName(ref)).toBe(true);
    },
  );

  it.each([
    ["path-traversal via ..", "refs/heads/fx/../main"],
    ["double dot mid-path", "refs/heads/fx/H..03"],
    ["double slash", "refs/heads/fx//H03"],
    ["reflog syntax", "refs/heads/fx/H03@{upstream}"],
    ["leading dot component", "refs/heads/fx/.hidden"],
    ["trailing .lock", "refs/heads/fx/H03.lock"],
    ["leading slash", "/refs/heads/fx/H03"],
    ["trailing slash", "refs/heads/fx/H03/"],
    ["trailing dot", "refs/heads/fx/H03."],
    ["bare @", "@"],
    ["space", "refs/heads/fx/H 03"],
    ["tilde", "refs/heads/fx/H~03"],
    ["caret", "refs/heads/fx/H^03"],
    ["colon", "refs/heads/fx/H:03"],
    ["question mark", "refs/heads/fx/H?03"],
    ["asterisk", "refs/heads/fx/H*03"],
    ["open bracket", "refs/heads/fx/H[03"],
    ["backslash", "refs/heads/fx/H\\03"],
    ["empty string", ""],
    ["control character", "refs/heads/fx/H\x0103"],
  ])("rejects: %s (%s)", (_label, ref) => {
    expect(isValidRefName(ref)).toBe(false);
  });
});
