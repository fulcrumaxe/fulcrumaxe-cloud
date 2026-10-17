import { describe, expect, expectTypeOf, it } from "vitest";
import type { Operations } from "../src/index.js";
import { operations } from "../src/index.js";

/**
 * D#483 S4-i, S4i-10: the generated client exposes the verification fields with their types. The type assertions are checked by
 * tsc (this file is in the package's include list); the runtime assertions pin the operation table.
 */
type ListRow = Operations["listProposals"]["response"]["proposals"][number];
type Detail = Operations["getProposal"]["response"]["proposal"];

describe("generated client: proposal verification fields", () => {
  it("every proposal row carries the verification fields and counts", () => {
    expectTypeOf<ListRow["verification"]>().toEqualTypeOf<"pending" | "verified" | "partly_verified" | "refuted" | "not_checked" | "check_failed">();
    expectTypeOf<ListRow["verified_at"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ListRow["verified_sha"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ListRow["verify_attempts"]>().toEqualTypeOf<number>();
    expectTypeOf<ListRow["verify_attempts_max"]>().toEqualTypeOf<number>();
    expectTypeOf<ListRow["verify_retry"]>().toEqualTypeOf<boolean>();
    expectTypeOf<ListRow["inbox_section"]>().toEqualTypeOf<"new" | "being_checked" | "couldnt_confirm" | "not_checked" | null>();
    expectTypeOf<ListRow["claim_counts"]>().toEqualTypeOf<{ supported: number; refuted: number; unverifiable: number; pending: number }>();
    expectTypeOf<ListRow["evidence_count"]>().toEqualTypeOf<number>();
    expect(operations.listProposals.scope).toBe("read");
    expect(operations.getProposal.scope).toBe("read");
  });

  it("the list rows carry no claims or evidence arrays, and the detail does", () => {
    expectTypeOf<ListRow>().not.toHaveProperty("claims");
    expectTypeOf<ListRow>().not.toHaveProperty("evidence");
    expectTypeOf<Detail["claims"][number]["verdict"]>().toEqualTypeOf<"supported" | "refuted" | "unverifiable" | "pending">();
    expectTypeOf<Detail["claims"][number]["refute_code"]>().toEqualTypeOf<"cite_not_found" | "cite_mismatch" | "contradicted" | null>();
    expectTypeOf<Detail["evidence"][number]["kind"]>().toEqualTypeOf<"file_lines" | "issue" | "discussion" | "doc_passage" | "interview_answer" | "preview">();
    expectTypeOf<Detail["evidence"][number]["url"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Detail["evidence"][number]["commit_sha"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Detail["evidence"][number]["excerpt"]>().toEqualTypeOf<string>();
  });

  it("the list takes a section filter", () => {
    expectTypeOf<NonNullable<Operations["listProposals"]["query"]>["section"]>().toEqualTypeOf<string | undefined>();
  });
});
