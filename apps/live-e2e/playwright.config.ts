import { buildConfig } from "./pw/config.js";

// The target comes from LIVE_E2E_TARGET (set by `live-e2e run`); see pw/config.ts.
export default buildConfig(process.env);
