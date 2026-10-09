import { describe, expect, it } from "vitest";
import { inRunnerJob } from "./needsHostSockets.js";
import { tmpRoot } from "./tmpRoot.js";

describe("the test helpers for a runner job's sandbox", () => {
  it("a test that needs host sockets skips on the job-env marker FX_RUNNER_JOB=1, and on nothing else", () => {
    expect(inRunnerJob({ FX_RUNNER_JOB: "1" })).toBe(true);
    for (const env of [{}, { FX_RUNNER_JOB: "" }, { FX_RUNNER_JOB: "0" }, { FX_RUNNER_JOB_SIGNER_ID: "1" }]) expect(inRunnerJob(env)).toBe(false);
  });

  it("scratch directories go under the process's own temp directory when that is below /tmp, and under /tmp otherwise", () => {
    const saved = process.env.TMPDIR;
    try {
      process.env.TMPDIR = "/tmp/claude/";
      expect(tmpRoot()).toBe("/tmp/claude");
      process.env.TMPDIR = "/var/folders/ab/T";
      expect(tmpRoot()).toBe("/tmp");
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});
