/**
 * D#749: the names shared by the verify driver, which makes the browser's TMPDIR outside the job directory, and the engine, which clears a re-claimed job's leftovers.
 * Kept apart from driver.ts so the engine does not load the browser driver to know them.
 */
export const BROWSER_TMP_PREFIX = "fxv-";
/** The file in the job directory that names this job's browser TMPDIR while it exists. It holds one absolute path and nothing else. */
export const BROWSER_TMP_RECORD = "browser-tmp";
/** The shape of a folder the driver made: `fxv-` and the six characters `mkdtemp` adds. Nothing else is ever removed through the record. */
export const BROWSER_TMP_NAME = /^fxv-[A-Za-z0-9]{6}$/;
