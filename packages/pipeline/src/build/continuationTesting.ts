/**
 * Test-only entry point, published as `@fx/pipeline/testing/continuation`. The two functions run the
 * continuation decision without the work-item lock, so a test can reproduce a lock lost before the child
 * row is written. Production code must not import this file: test/build/continuationTestingGuard.test.ts
 * fails when it does.
 */
export { continueAfterLimitLocked, continueWorkItemLocked } from "./continuation.js";
