import { describe, expect, it } from "vitest";
import { callStatus, classifyLinkEdit, type CallStatus } from "./helpers/canaryClassify.js";

describe("canary: classification of the Edit-through-a-link probe (d)", () => {
  it("is covered when the Read through the link was denied and the bytes are unchanged", () => {
    expect(classifyLinkEdit("not_read", "denied", true)).toBe("PASS");
  });

  it("stays INCONCLUSIVE when the bytes changed, or (d0) was anything but denied", () => {
    expect(classifyLinkEdit("not_read", "denied", false)).toBe("INCONCLUSIVE");
    for (const d0 of ["allowed", "missing", "no_result", "not_read"] as CallStatus[]) {
      expect(classifyLinkEdit("not_read", d0, true)).toBe("INCONCLUSIVE");
    }
  });

  it("passes a real permission denial only while the bytes are unchanged", () => {
    expect(classifyLinkEdit("denied", "allowed", true)).toBe("PASS");
    expect(classifyLinkEdit("denied", "denied", false)).toBe("FAIL");
  });

  it("fails an Edit that was allowed, never made, or has no result, whatever (d0) did", () => {
    for (const d of ["allowed", "missing", "no_result"] as CallStatus[]) {
      expect(classifyLinkEdit(d, "denied", true)).toBe("FAIL");
    }
  });

  it("reads a call's status from its result", () => {
    expect(callStatus(undefined, false)).toBe("missing");
    expect(callStatus(undefined, true)).toBe("no_result");
    expect(callStatus({ isError: false, text: "ok" }, true)).toBe("allowed");
    expect(callStatus({ isError: true, text: "File has not been read yet. Read it first" }, true)).toBe("not_read");
    expect(callStatus({ isError: true, text: "outside the working directory" }, true)).toBe("denied");
  });
});
