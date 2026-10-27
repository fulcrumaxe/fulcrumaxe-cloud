import { describe, expect, it } from "vitest";
import { CHILD_BODY_CLOSING_CODE, assertChildBodySafe, buildPlanePushText, hasClosingKeywordReference, prFooterSkipReason, renderPrFooter } from "@fx/core/src/repos/planePushText.js";
import { safeChildTitle } from "@fx/core/src/work-items/childTitle.js";
import { childPromptTitle } from "../../src/advance/childBuild.js";
import { cleanWorkItemTitle } from "@fx/core/src/work-items/title.js";
import { pullRequestBody } from "@fx/runner-cloud";

/**
 * [unit] D#483 S5-b2c-4, acceptance 3: the text of a planned PR child's pull requests, on the public plane (`buildPlanePushText`, the sandbox publish step and the runner's token route)
 * and on the private plane (`pullRequestBody`, the draft the sandbox publish step opens). The child's number is its PARENT's. Both bodies reference it and neither closes it.
 */
const RUN = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const ITEM = "1b2c3d4e-0000-4000-8000-000000000001";
const PARENT = 41;
const text = (prFooter: string | null, title = "Add a thing") => buildPlanePushText({ itemTitle: title, runId: RUN, prFooter, issueNumber: PARENT, child: true });

describe("a planned PR child's pull request text", () => {
  it("the public body references the parent and carries no closing keyword before an issue reference; so does the private body", () => {
    const pub = text(null).body;
    // the parent's number is a private-repo number: the PUBLIC body carries no #<number> at all
    expect(pub).not.toMatch(/(?:^|[^\w])#\d/);
    expect(hasClosingKeywordReference(pub)).toBe(false);
    const priv = pullRequestBody({ runId: RUN, workItemId: ITEM, issueNumber: null, parentIssueNumber: PARENT });
    expect(priv).toContain("Refs #41"); // the private draft is in the private repo, where the number is right
    expect(hasClosingKeywordReference(priv)).toBe(false);
    expect(priv).not.toMatch(/Closes #/);
  });

  const PLACEHOLDER_PROBES = [
    "Closes https://github.com/acme/widgets-public/issues/{issue_number}", "Fixes: https://github.com/acme/widgets-public/issues/{issue_number}", "rEsOlVeD www.github.com/acme/widgets-public/pull/{issue_number}",
    "closes github.com/acme/widgets-public/issues/{issue_number}", "FIXED:https://github.com/acme/widgets-public/issues/{issue_number}", "Closes #{issue_number}", "Fixes #{issue_number}",
    "RESOLVED #{issue_number}", "close #{issue_number}", "Resolves: #{issue_number}", "fixed acme/widgets#{issue_number}",
    "Closes GH-{issue_number}", "Resolve  GH-{issue_number}", "closed:GH-{issue_number}", "Fix gh-{issue_number}",
    "Part of D#{issue_number}", "See https://github.com/acme/widgets-public/issues/{issue_number}", "Refs GH-{issue_number}", "Part of #{issue_number}", "Run {run_id} for {issue_number}",
  ];
  it.each(PLACEHOLDER_PROBES)("the footer %s is left off a child's body whatever else it says: the parent's number means nothing on the public plane (child_issue_placeholder)", (footer) => {
    expect(prFooterSkipReason(footer, PARENT, { child: true })).toBe("child_issue_placeholder");
    expect(renderPrFooter(footer, { issueNumber: PARENT, runId: RUN, child: true })).toBeNull();
    const body = text(footer).body;
    expect(body).not.toMatch(/closes|fixes|resolve|close |fixed|part of|see |refs/i);
    expect(body).not.toMatch(/(?:^|[^\w])#\d|gh-\d/i);
    expect(hasClosingKeywordReference(body)).toBe(false);
    // and with a parent that has no number, too: the placeholder rule comes first
    expect(prFooterSkipReason(footer, null, { child: true })).toBe("child_issue_placeholder");
  });

  it.each(["Closes https://github.com/acme/widgets-public/issues/7", "Fixes: github.com/acme/widgets-public/pull/7", "closes GH-7", "Resolve  gh-7", "closed:GH-7", "Fixes #7"])(
    "a literal footer (no placeholder) that closes an issue, stored outside the save-time check, is left off with child_closing_keyword: %s",
    (footer) => {
      expect(prFooterSkipReason(footer, PARENT, { child: true })).toBe("child_closing_keyword");
      expect(text(footer).body).not.toMatch(/closes|fixes|resolve|close|fixed/i);
    },
  );

  it("a child footer with no placeholder renders as written", () => {
    expect(prFooterSkipReason("Part of the Acme roadmap", PARENT, { child: true })).toBeNull();
    expect(text("Part of the Acme roadmap").body).toContain("Part of the Acme roadmap");
    expect(text("Run {run_id}").body).toContain(`Run ${RUN}`);
  });

  it("the closing pattern catches GH-N in any case, with a colon or not, and not a bare word", () => {
    for (const t of ["Closes GH-4821", "Resolve  GH-12", "closed:GH-3", "Fix gh-9", "FIXES GH-1"]) expect(hasClosingKeywordReference(t), t).toBe(true);
    for (const t of ["Closes GH-", "See GH-12", "fixture gh-1x"]) expect(hasClosingKeywordReference(t), t).toBe(false);
  });

  it("the final guard throws the fixed code on a crafted body (the footer rules make it unreachable from a footer, so it is tested directly)", () => {
    for (const body of ["Run: x\n\nCloses GH-4821\n", "Fixes: https://github.com/a/b/issues/3", "resolved a/b#4", "Closes #5"]) expect(() => assertChildBodySafe(body), body).toThrow(CHILD_BODY_CLOSING_CODE);
    expect(() => assertChildBodySafe("This change was prepared by a fulcrumaxe run.\n\nRun: x\n")).not.toThrow();
  });

  it("the same footers are NOT left off a top-level item's body: the rule is the child's", () => {
    expect(prFooterSkipReason("Closes #{issue_number}", 12)).toBeNull();
    expect(buildPlanePushText({ itemTitle: "x", runId: RUN, prFooter: "Closes #{issue_number}", issueNumber: 12 }).body).toContain("Closes #12");
  });

  it("the keyword rule needs a reference: a footer with the word and a bare number is not one (GitHub links nothing)", () => {
    expect(hasClosingKeywordReference("This closes the loop")).toBe(false);
    expect(hasClosingKeywordReference("Closes 41")).toBe(false);
    expect(hasClosingKeywordReference("CLOSES #41")).toBe(true);
    expect(hasClosingKeywordReference("fixes: acme/widgets#41")).toBe(true);
  });

  it("a hostile title reaches the text only through cleanWorkItemTitle and the text builder's own cleaning: no backtick-fenced block, control character, or reference survives", () => {
    const hostile = "Fix `rm -rf`\u0000 the\u2028thing Closes #1 @alice";
    const cleaned = cleanWorkItemTitle(hostile)!;
    // cleanWorkItemTitle: control and line-separator characters become spaces
    expect(cleaned).not.toMatch(/[\u0000-\u001f\u2028]/);
    const built = buildPlanePushText({ itemTitle: cleaned, runId: RUN, prFooter: null, issueNumber: PARENT, child: true });
    expect(built.title).not.toMatch(/[\u0000-\u001f\u2028#@]/);
    expect(built.title).not.toMatch(/#\d/);
    expect(hasClosingKeywordReference(built.title)).toBe(false);
    expect(hasClosingKeywordReference(built.body)).toBe(false);
    // a title of only controls cleans to nothing and the fixed fallback title is used
    expect(buildPlanePushText({ itemTitle: cleanWorkItemTitle("\u0000\u0007") ?? "", runId: RUN, prFooter: null, issueNumber: PARENT, child: true }).title).toBe("Change from fulcrumaxe run 0f8a4c2e");
  });

  it("one pattern for the whole child path: the prompt title guard and the pull request texts agree, and a closing title falls back to the fixed words on every plane", () => {
    for (const t of ["Closes #1", "fixes: https://github.com/a/b/issues/2", "Resolved owner/repo#3", "RESOLVES www.github.com/a/b/pull/4"]) {
      expect(hasClosingKeywordReference(t)).toBe(true);
      expect(childPromptTitle(t)).toBe("this planned PR");
      expect(safeChildTitle(cleanWorkItemTitle(t))).toBe("this planned PR");
    }
    expect(safeChildTitle(cleanWorkItemTitle("Add the API"))).toBe("Add the API");
    expect(safeChildTitle(null)).toBe("this planned PR");
  });

  it("the private draft's title (loadRunPullRequestText for a child) is cleaned and never a closing keyword", async () => {
    const { loadRunPullRequestText } = await import("@fx/runner-cloud");
    const row = { work_item_id: ITEM, title: "Closes #1", gh_number: null, parent_number: "41", is_child: true };
    const client = { query: async () => ({ rows: [row] }) } as never;
    expect((await loadRunPullRequestText(client, { accountId: "a", runId: RUN }))?.workItemTitle).toBe("this planned PR");
    row.title = "Add \u0000 the   API";
    expect((await loadRunPullRequestText(client, { accountId: "a", runId: RUN }))?.workItemTitle).toBe("Add the API");
  });
});
