/**
 * D#483 S5-b2c-1: the pairing guard between the child launch gate and the build.
 *
 * A launched planned PR child would reach `startBuildForItem` before that function can build for a child (it has no issue number of its own and no Spec version of
 * its own), and would stop at `no_issue_link`. So until the build supports a child, the launch gate lists and derives reasons but files nothing (the sweep answers
 * `not_ready`), and a person's Approve on a planned PR answers 409 `child_build_unsupported`. The build row sets this to true in the same change that adds the build
 * support. It is code, not a setting: no environment variable or database value can turn the gate on ahead of the build.
 */
export const CHILD_BUILD_SUPPORTED = false;
