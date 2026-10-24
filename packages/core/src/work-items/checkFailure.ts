/**
 * A failed check that is not the build's fault, read from the check's own summary.
 *
 * The runner's summary starts with a few header lines it wrote itself (before the output tail): `failed test files (N): a, b` names the test files the output
 * reported as failed, and `changed files (M): x, y` names the files the branch changed against the default branch. When every failed test file lies in a package (apps/<x>, packages/<y>, scripts/<z>) that holds NO changed
 * file, a fix round cannot help: the agent is asked to change code that the failure does not come from (the environment, or code already on the default branch), and
 * the round only spends an attempt. The item goes to Needs a person instead. A failure in a package the change touched, or anything this reader cannot be sure of, keeps today's
 * behaviour (a fix round).
 *
 * Fail closed toward the fix round: a missing line, a line that was cut, a list that is shorter than its count (`and K more`), a name that is not a plain relative path,
 * or no failed file at all is "not decided here". Only the header at the very top of the summary is read, never the output tail below it. (A test script can print
 * those lines in the tail, but the tail is not read; and even if it were, the only effect of such text is to send the item to a person, never to hide a failure.)
 */
export const CHECK_FAILED_OUTSIDE_CHANGE = 'check_failed_outside_change';

const PACKAGE_ROOTS = ['apps', 'packages', 'scripts'];

/** `apps/ops/test/a.ts` -> `apps/ops`; null for a path that maps to no package (the repo root, or a name relative to a project). */
function packageOf(path: string): string | null {
  const parts = path.split('/');
  return parts.length >= 3 && PACKAGE_ROOTS.includes(parts[0]!) ? `${parts[0]}/${parts[1]}` : null;
}

export const CHECK_FAILED_OUTSIDE_CHANGE_SENTENCE =
  "The check failed in parts of the repo this change didn't touch, so a fix round would not help: the failure comes from the environment or from code that is already on the base branch. Nothing was started. Look at the check's output in the run, then press Build again if it was a one-off, or fix the base branch.";

/** The header lines the runner writes before the output tail. Anything else ends the header. */
const HEADER_PREFIXES = [
  'failed test files (',
  'changed files (',
  'the check needed the network',
  'check files changed by this branch:',
  'check files not given back',
  'the check changed paths it may not',
  'not put back:',
  'not pinned (',
] as const;

/** A plain relative file name, the runner's own `NAMED_FILE` rule. Anything else was counted but not named. */
const NAMED_FILE = /^[A-Za-z0-9_@+][A-Za-z0-9_./@+-]{0,255}$/;

interface FileLine {
  count: number;
  files: Set<string>;
  /** The line names every file it counts: nothing cut, nothing "and K more", nothing unnamed. */
  complete: boolean;
}

function readFileLine(line: string, prefix: string): FileLine | null {
  if (!line.startsWith(prefix)) return null;
  const match = line.slice(prefix.length).match(/^(\d{1,6})\): (.*)$/);
  if (match === null) return null;
  const count = Number(match[1]);
  let rest = match[2] ?? '';
  let cut = false;
  const more = rest.match(/ \(and (\d{1,6}) more\)$/);
  if (more !== null) {
    cut = true;
    rest = rest.slice(0, rest.length - more[0].length);
  }
  const names = rest === '' ? [] : rest.split(', ');
  const files = new Set<string>();
  let plain = true;
  for (const name of names) {
    if (NAMED_FILE.test(name)) files.add(name);
    else plain = false;
  }
  return { count, files, complete: !cut && plain && count > 0 && files.size === count && names.length === count };
}

/**
 * True when the summary's header proves that the check failed only in test files the change did not touch. False in every other case, including every case this
 * reader cannot be sure of.
 */
export function failedOutsideChange(summary: string | null | undefined): boolean {
  if (typeof summary !== 'string' || summary === '') return false;
  let failed: FileLine | null = null;
  let changed: FileLine | null = null;
  for (const line of summary.split('\n')) {
    if (!HEADER_PREFIXES.some((p) => line.startsWith(p))) break;
    failed ??= readFileLine(line, 'failed test files (');
    changed ??= readFileLine(line, 'changed files (');
  }
  if (failed === null || changed === null || !failed.complete || !changed.complete) return false;
  // Package level: a failed test file is outside the change only when its package holds no changed file. A package is the first two path segments under apps/,
  // packages/ or scripts/. A name outside those (the repo root, or a name a runner printed relative to its own project, which cannot be mapped) is ambiguous, and
  // an ambiguous name keeps the fix round.
  const touched = new Set<string>();
  for (const path of changed.files) touched.add(packageOf(path) ?? '.');
  for (const file of failed.files) {
    const pkg = packageOf(file);
    if (pkg === null || touched.has(pkg)) return false;
  }
  return true;
}
