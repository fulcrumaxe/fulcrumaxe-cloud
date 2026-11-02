/**
 * D#483 S5-b2d-2a: the pairing guard between the follow-up child producer and the launch that does not exist yet.
 *
 * The producer (the auto-start sweep's follow-up pass) makes a work item of a recorded follow-up only while this is true. It is false: a child made now would
 * sit at `triaged` with nothing able to start it. The launch row (S5-b2d-2b) flips it. It stays code, not a setting: no environment variable or database value
 * can turn the producer on ahead of the launch. While false, a follow-up stays a note on its parent's card.
 */
export const FOLLOW_UP_CHILD_START_SUPPORTED = false;
