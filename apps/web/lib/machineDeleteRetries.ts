/**
 * Retries a server-delete step gets after its first try: the Workflow runtime's default, written down so the last try can be told (the run is marked failed on the try after this many).
 * `maxRetries` is not assigned on the steps, because doing so breaks the build's workflow graph extraction; `workflows/machineDeleteRetries.test.ts` fails if the runtime's default moves.
 */
export const DELETE_STEP_RETRIES = 3;
