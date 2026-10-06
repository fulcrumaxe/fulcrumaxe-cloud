// Input for no-free-text.test.ts: a registered code, typed fields, an Error passed as an object.
import { createLogger } from "../../src/index.js";

const log = createLogger({ service: "fixture" });
declare const runId: string;
declare const err: Error;

log.info("telemetry.selftest", { run_id: runId, status: 200, route: "/api/v1/runs" });
log.error("telemetry.selftest", { error: err, count: 1 + 1 });
const label = `built outside a logger call ${runId}`;
void label;
