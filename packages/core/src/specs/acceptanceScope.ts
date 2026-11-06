/** Moved to the runner protocol package so the local runner can test the paths it changed with the same matcher the cloud holds a pull request to; this file keeps the old import path working. */
export { MAX_ENTRY_PATTERNS, MAX_SCOPE_ENTRIES, MAX_SCOPE_PATTERNS, WORKSPACE_LOCKFILES, parseAcceptanceScope, pathInScope, pathsOutsideScope, type AcceptanceScope } from '@fulcrumaxe/runner-protocol';
