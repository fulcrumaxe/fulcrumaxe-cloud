import { describe, expect, it } from "vitest";
import { createErrorReporter } from "@fx/telemetry";
import { runnerNoticeReports } from "../src/runnerNotices.js";

/** D#6 R2b-3h: what the notice sweep reports is a code and an id, through the real reporter, and nothing a failure carried. */
describe("runnerNoticeReports", () => {
  const RUN = "11111111-1111-4111-8111-111111111111";
  function wired() {
    const lines: Array<Record<string, unknown>> = [];
    const warns: string[] = [];
    const classes: Array<Record<string, string>> = [];
    const reporter = createErrorReporter({ service: "worker", write: (line) => void lines.push(JSON.parse(line)), sink: { record: (event) => void classes.push({ ...event }) } });
    return { lines, warns, classes, reports: runnerNoticeReports({ report: reporter.reportError, warn: (line) => void warns.push(line) }) };
  }

  it("a failed run is one runner_notice_failed report, and a log line with the run id and nothing else", () => {
    const { lines, warns, classes, reports } = wired();
    reports.onError(RUN, new Error("connection refused: secret-host.internal password=hunter2"));
    expect(classes).toEqual([{ service: "worker", route: "/", stage: "runner.notice", code: "runner_notice_failed" }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "error.reported", error_code: "runner_notice_failed", stage: "runner.notice" });
    expect(JSON.parse(warns[0]!)).toEqual({ event: "runner.notice_sweep_failed", run_id: RUN });
    expect(JSON.stringify([lines, warns, classes])).not.toMatch(/secret-host|hunter2|refused/);
  });

  it("a full page is one runner_notice_backlog report with no id and no text", () => {
    const { lines, warns, classes, reports } = wired();
    reports.onBacklog();
    expect(classes).toEqual([{ service: "worker", route: "/", stage: "runner.notice", code: "runner_notice_backlog" }]);
    expect(lines[0]).toMatchObject({ error_code: "runner_notice_backlog" });
    expect(warns).toEqual([]);
  });
});
