import { createLogger } from "@fx/telemetry";

/** The console's logger: registered event codes and typed fields only (see packages/telemetry). */
export const log = createLogger({ service: "ops" });
