/**
 * D#483 S5-b2d-2a / 2b: the pairing guard between the follow-up child producer and the launch. The producer (the auto-start sweep's follow-up pass) makes a work item of a
 * recorded follow-up, and "Make it an item" opens, only while this is true. It is true now: the launch exists (migration 0965; the sweep's launch pass, a person's Approve,
 * the `light_spec` entry and the build). It stays code, not a setting. Defined in @fx/core so the stage table can read it too.
 */
export { FOLLOW_UP_CHILD_START_SUPPORTED } from "@fx/core/src/work-items/advance.js";
