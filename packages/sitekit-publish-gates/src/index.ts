export type { Finding, GateResult } from "./types.js";
export { run as scanLeaks, scanText } from "./leak/scan.js";
export type { LeakOptions } from "./leak/scan.js";
export { run as checkLinkPolicy, normalizeLink } from "./links/links.js";
export type { LinkPolicyOptions } from "./links/links.js";
export { runPublishGates, persistGateReport } from "./report.js";
export type { PublishGateReport, Queryable } from "./report.js";
export { attest, carryForward, approve, buildVerifyReport } from "./approval/index.js";
export type { ApproveOptions, VerifyReport, ReportBlocker, EvidenceLink, ApprovalDb, Principal, Refusal, Outcome } from "./approval/index.js";
