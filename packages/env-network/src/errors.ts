export type NetworkErrorCode =
  | "empty" | "wildcard" | "ip_address" | "address_range" | "not_a_hostname" | "reserved_host" | "special_use_host" | "invalid_context";

const SHOWN = 80;

/**
 * A named refusal. The message carries the offending entry (cut to 80 characters, JSON-escaped so control
 * characters cannot forge a log line) and nothing else -- no policy internals, no other tenant's data.
 */
export class EnvNetworkError extends Error {
  constructor(readonly code: NetworkErrorCode, readonly entry: string, detail: string) {
    super(`${code}: ${entry.length > SHOWN ? JSON.stringify(`${entry.slice(0, SHOWN)}...`) : JSON.stringify(entry)} ${detail}`);
    this.name = "EnvNetworkError";
  }
}
