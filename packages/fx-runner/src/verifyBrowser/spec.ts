/**
 * D#749 V2c-2b: how the CLI starts the runner's own `fxverify` MCP server for one playwright job. `command` and `args` are this program's own command (`host.selfCommand`, the
 * binary itself in the release build); the three settings are the owner's, read from the runner's settings file at the job's start. Nothing here comes from a job or the cloud.
 */
export interface VerifyServerSpec {
  command: string;
  args: readonly string[];
  baseUrl: string;
  executable: string;
  storageState: string;
  /** Set only with a usable protection bypass file whose registered cloud origin is the base's origin: the PATH of the file (never its content) and that origin. */
  bypassFile?: string;
  cloudOrigin?: string;
}
