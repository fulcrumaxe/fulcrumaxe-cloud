import { describe, expect, it } from "vitest";
import { ACTIVITY_ROW_KIND, activityRowProblem } from "../src/activityRow.js";

describe("activityRowProblem", () => {
  const row = (payload: unknown, kind = ACTIVITY_ROW_KIND) => ({ kind, payload });
  it("accepts the rows the runner writes", () => {
    expect(activityRowProblem(row({ tool: "read", path: "src/a.ts" }))).toBeNull();
    expect(activityRowProblem(row({ tool: "test", command: "pnpm test" }))).toBeNull();
  });
  it("names a row that drifted: another kind, another key, an unknown tool, a non-string value, no object", () => {
    for (const bad of [row({ tool: "read" }, "agent.note"), row({ tool: "read", extra: "x" }), row({ tool: "write", path: "a" }), row({ tool: "read", path: 1 }), row(null), row(["read"])]) {
      expect(activityRowProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });
});
