// Input for no-free-text.test.ts: each logger call below builds text, once per forbidden shape.
import { createLogger } from "../../src/index.js";

const log = createLogger({ service: "fixture" });
declare const who: string;
declare const body: unknown;

log.info("telemetry.selftest", { route: `/api/v1/runs/${who}` });
log.warn("telemetry.selftest", { route: "/api/v1/runs/" + who });
log.error("telemetry.selftest", { route: JSON.stringify(body) });
