/**
 * D#845 ON-27c2: what a private twin's publish shares between the cloud and the runner.
 *
 * TWIN_FIXED_PRIVATE is the one list of paths that are private on every twin (the fixed engine roots and the secret defaults); the cloud's twin paths module imports it from here.
 *
 * buildTwinPublishText is the fixed template of a publish pull request, a PURE function of a count, a date and the list of paths that are published. The paths go public with the commit anyway; nothing else is an input,
 * so no private pull request title, Discussion number, repository name or twin name can reach the public text. The runner builds it from what it computed itself, and the route scans it with the commit.
 * GitHub turns `@name` and `#12` into notifications and links, so the paths sit in a code fence, where it does not; a path with a backtick or a control character is counted but not listed.
 */
export const TWIN_FIXED_PRIVATE: readonly string[] = [".autonomous-team/**", ".claude/**", "CLAUDE.md", "CLAUDE.project.md", "docs/PRD.md", "epics/**", ".env", ".env.*", "**/*.pem", "**/*.key"];

/**
 * An exact install path as an overlay entry. The overlay compiler refuses a bracket expression and a backslash, so a path with `[` or `]` (a route folder such as `app/[id]/page.tsx`) cannot be listed as it is: each
 * bracket becomes `?`, one any character. The entry still matches the path itself and can only cover a few more files, never fewer, so a private file is never published (stricter, never looser).
 */
export const installPathGlob = (path: string): string => path.replace(/[[\]]/g, "?");

/** The list the publish and the parity check compile as the twin's private set: the fixed roots, the person's globs and the install's exact paths. The one place it is put together. */
export const twinPrivateOverlay = (set: { overlayGlobs: readonly string[]; installPaths: readonly string[] }): string[] => [...TWIN_FIXED_PRIVATE, ...set.overlayGlobs, ...set.installPaths.map(installPathGlob)];

/** The most paths the body lists; the rest are counted. */
export const TWIN_PUBLISH_MAX_LISTED = 200;
export const TWIN_PUBLISH_FOOTER = "Opened by the publisher. Look through the files above, then merge to publish them. Nothing else from the private working copy is in this change.";
const UNLISTABLE = /[`\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export interface TwinPublishText {
  title: string;
  body: string;
}

export function buildTwinPublishText(input: { commits: number; date: string; paths: readonly string[] }): TwinPublishText {
  if (!Number.isSafeInteger(input.commits) || input.commits < 1) throw new TypeError("buildTwinPublishText: commits must be a positive integer");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new TypeError("buildTwinPublishText: date must be YYYY-MM-DD");
  const listable = input.paths.filter((p) => !UNLISTABLE.test(p));
  const shown = listable.slice(0, TWIN_PUBLISH_MAX_LISTED);
  const hidden = input.paths.length - shown.length;
  const title = `Publish ${input.commits} merged ${input.commits === 1 ? "change" : "changes"} from fulcrumaxe (${input.date})`;
  const list = shown.length === 0 ? "" : `\n\n\`\`\`\n${shown.join("\n")}\n\`\`\``;
  const more = hidden > 0 ? `\n\nand ${hidden} more not listed here` : "";
  return { title, body: `Files: ${input.paths.length}${list}${more}\n\n${TWIN_PUBLISH_FOOTER}` };
}
