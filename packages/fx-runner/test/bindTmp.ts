import { inject } from "vitest";

// Worker side of the temp-directory leak check (see globalSetup.ts): this package's tests use the run's own temp root, so a
// leak is counted against this package and not against whatever else shares the host's temp directory.
const root = inject("fxTmpRoot");
if (root !== undefined) process.env["TMPDIR"] = root;
