/**
 * no-silent-catch: a `catch` clause in server code must do one of four things, or it hides a failure.
 *
 *   1. rethrow (a `throw` in the clause, not inside a function declared in it),
 *   2. call `reportError(...)` (bare, or as a member such as `telemetry.reportError(...)`),
 *   3. call `.error(...)` or `.warn(...)` on a logger (an object or property named `log` or `logger`),
 *   4. carry a comment `// fx-swallow-ok: <reason>` inside the clause, with a reason.
 *
 * The rule began over a baseline: `no-silent-catch.baseline.json` maps a file to the number of silent catches it
 * had when the rule landed (counts, not line numbers, so an unrelated edit above a catch does not move it), and the
 * adoption PRs lowered the counts as they fixed sites. The file is now empty, so every silent catch is an error.
 * The `baseline` option stays so a file that must be added later has a place to be listed; the "baseline is exact"
 * test (no-silent-catch.test.mjs) fails when a count is higher or lower than the tree.
 *
 * Out of scope on purpose: `.catch(fn)` on a promise (a different shape; the adoption PRs look at those by hand)
 * and client code in apps/workspace (its failures go through the session/rum path, not this rule).
 */
import path from "node:path";

const OK_COMMENT = /fx-swallow-ok:\s*\S/;
const LOGGER_NAME = /^(log|logger)$/i;

function nameOf(node) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") return node.property.name;
  return undefined;
}

/** A call that reports: reportError(...), x.reportError(...), logger.error(...), this.log.warn(...). */
export function isReportingCall(call) {
  const callee = call.callee;
  // reportSyncFailure (packages/github) is reportError with the sync stage and code read off the error.
  if (callee.type === "Identifier") return callee.name === "reportError" || callee.name === "reportSyncFailure";
  if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return false;
  if (callee.property.name === "reportError") return true;
  if (callee.property.name !== "error" && callee.property.name !== "warn") return false;
  const owner = nameOf(callee.object);
  return owner !== undefined && LOGGER_NAME.test(owner);
}

function makeRule(report) {
  return {
    meta: {
      type: "problem",
      schema: [{ type: "object", properties: { baseline: { type: "object", additionalProperties: { type: "integer", minimum: 0 } } }, additionalProperties: false }],
      messages: {
        silent:
          "This catch swallows the error. Rethrow it, call reportError(err, { stage, route }) or a logger's error/warn, or add `// fx-swallow-ok: <reason>`.",
      },
    },
    create(context) {
      const baseline = context.options[0]?.baseline ?? {};
      const file = path.relative(context.cwd ?? process.cwd(), context.filename).split(path.sep).join("/");
      const allowed = baseline[file] ?? 0;
      const sourceCode = context.sourceCode;
      let seen = 0;
      /** One frame per catch clause being walked. */
      const frames = [];
      let functionDepth = 0;
      const functionDepthAtEntry = [];

      return {
        CatchClause(node) {
          frames.push({ node, ok: false });
          functionDepthAtEntry.push(functionDepth);
        },
        "CatchClause:exit"(node) {
          const frame = frames.pop();
          functionDepthAtEntry.pop();
          if (!frame || frame.ok) return;
          if (sourceCode.getCommentsInside(node).some((c) => OK_COMMENT.test(c.value))) return;
          const index = seen++;
          report(context, node, index < allowed);
        },
        ThrowStatement() {
          const top = frames.length - 1;
          if (top >= 0 && functionDepth === functionDepthAtEntry[top]) frames[top].ok = true;
        },
        CallExpression(node) {
          if (frames.length > 0 && isReportingCall(node)) frames[frames.length - 1].ok = true;
        },
        ":function"() {
          functionDepth++;
        },
        ":function:exit"() {
          functionDepth--;
        },
      };
    },
  };
}

export const rules = {
  "no-silent-catch": makeRule((context, node, baselined) => {
    if (!baselined) context.report({ node, messageId: "silent" });
  }),
};

export default { rules };
