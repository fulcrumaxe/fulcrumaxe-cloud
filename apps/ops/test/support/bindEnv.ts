import { inject } from "vitest";

// The globalSetup's database URLs, put into this worker's own environment (see packages/db/test/support/bind-test-env.ts).
const env = inject("opsDbEnv");
process.env.DATABASE_URL = env.migrationUrl;
process.env.TEST_OPS_CONSOLE_URL = env.opsConsoleUrl;
