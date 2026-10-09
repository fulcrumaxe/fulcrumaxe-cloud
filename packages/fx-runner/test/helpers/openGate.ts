import type { SandboxGate } from "../../src/daemon/sandboxGate.js";

/** A claim gate that is open: the sandbox works. For the tests that are about something else. */
export const OPEN_GATE: SandboxGate = { check: async () => ({ open: true }) };
