import path from "node:path";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A name that is not exactly one plain path segment. The message never carries the name. */
export class NotAPlainSegment extends Error {
  readonly code = "bad_segment";
  constructor() {
    super("bad_segment");
    this.name = "NotAPlainSegment";
  }
}

/**
 * `root` joined with `name`, where `name` must be one plain path segment: letters, digits, `.`, `_` and `-` only, no
 * leading dot, no `..` inside, at most 128 characters. The shape alone puts the result directly under `root` (no
 * separator, so no second level; no leading dot or `..`, so no climb). Every directory this package makes from a name
 * that came from outside (the job directory, the workspace, the sandbox's temp directory) is made through this one function.
 */
export function segmentUnder(root: string, name: string): string {
  if (!SEGMENT.test(name) || name.includes("..")) throw new NotAPlainSegment();
  return path.join(root, name);
}
