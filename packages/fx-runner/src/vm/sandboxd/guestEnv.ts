/**
 * The microVM engine's own environment table (D#587 ruling 5): the one list of names a job's environment may carry into a guest, and what
 * the pinned ones may say. The host engine keeps its own (the clean environment, exactly); each engine checks against its own table.
 *
 *  - The table is closed. A name outside it is refused, so a subscription or OAuth token, a cloud key or anything else a job carries never reaches
 *    the runtime or the guest. The subscription token goes into the guest over vsock to tmpfs (B-6), never through the environment.
 *  - No CA variable is in it. The guest trusts no interception CA, so the curl, git and node CA-file names stay unset and tools use the image's own
 *    trust store. Tool base URLs point at the guest relay to the reverse endpoint instead, and every other host goes through the CONNECT relay.
 *  - The fixed names (`FIXED_ENV`) and the network names are pinned: a wrong value is refused, a missing one is added (`guestEnvOf`).
 *  - The names the host engine copies from the host (`PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`) are not carried into the guest: the guest
 *    agent user's own values replace them.
 */
import { FIXED_ENV, HOST_ENV_ALLOWLIST } from "../../job/cleanEnv.js";

/** The guest-side CONNECT relay (`127.0.0.1:5253`); the reverse relay is `127.0.0.1:80`. The guest image provides both. */
const CONNECT_RELAY = "http://127.0.0.1:5253";
/**
 * The hosts the guest reaches through the reverse relay (the guest's hosts file maps each to `127.0.0.1`, which the relay carries to vsock 5254)
 * instead of the CONNECT relay: the model API, and GitHub for git. One list feeds both the tool base URL and `NO_PROXY`, so a client that follows
 * proxy variables sends these hosts straight to the reverse relay (a plain-http request through the CONNECT relay is refused) and the two cannot drift.
 */
export const REVERSE_HOSTS: readonly string[] = Object.freeze(["api.anthropic.com", "github.com"]);
const NO_PROXY_VALUE = ["127.0.0.1", "localhost", ...REVERSE_HOSTS].join(",");

/** Names the guest's own network setup sets; a job may only repeat them with exactly these values. */
export const MICROVM_NETWORK_ENV: Readonly<Record<string, string>> = Object.freeze({
  HTTPS_PROXY: CONNECT_RELAY,
  HTTP_PROXY: CONNECT_RELAY,
  https_proxy: CONNECT_RELAY,
  http_proxy: CONNECT_RELAY,
  NO_PROXY: NO_PROXY_VALUE,
  no_proxy: NO_PROXY_VALUE,
  ANTHROPIC_BASE_URL: `http://${REVERSE_HOSTS[0] as string}`,
});

/**
 * Every name a job may only repeat with exactly this value: the network names, and the fixed names the host engine pins too (`FIXED_ENV`: the
 * flag that keeps the CLI's credential out of its tool subprocesses, the job marker, the two context levers).
 */
export const MICROVM_PINNED_ENV: Readonly<Record<string, string>> = Object.freeze({ ...FIXED_ENV, ...MICROVM_NETWORK_ENV });

/**
 * The guest agent user's own values for the names the host engine copies from the host. They mirror the guest agent (`USER` and `BASE_ENV` in the
 * image's `agent.py`; `/tmp` is a tmpfs the init mounts), and a test holds them to it. A job's value for these names is never carried into the
 * guest, so the host's own paths and login name stay on the host.
 */
export const MICROVM_GUEST_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: "/opt/fx/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/vercel",
  USER: "ubuntu",
  LOGNAME: "ubuntu",
  TMPDIR: "/tmp",
});

/** Every name a job's environment may carry into a microVM guest. */
export const MICROVM_ENV_NAMES: ReadonlySet<string> = new Set<string>([...HOST_ENV_ALLOWLIST, ...Object.keys(MICROVM_PINNED_ENV)]);

const MAX_VALUE_CHARS = 8192;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * True when every name is in the microVM table, every value is a plain string with no control character (no NUL, no newline), and a pinned name
 * carries exactly its pinned value. A guest-valued name takes any clean value here: `guestEnvOf` replaces it, so it is never forwarded.
 */
export function microvmEnvAllowed(env: unknown): boolean {
  if (env === null || typeof env !== "object" || Array.isArray(env)) return false;
  for (const [name, value] of Object.entries(env)) {
    if (!MICROVM_ENV_NAMES.has(name) || typeof value !== "string" || value.length > MAX_VALUE_CHARS || CONTROL.test(value)) return false;
    const pinned = MICROVM_PINNED_ENV[name];
    if (pinned !== undefined && value !== pinned) return false;
  }
  return true;
}

/** The environment a guest process gets from an already checked job environment: the guest's own values, then every pinned name, laid over it. */
export function guestEnvOf(env: Readonly<Record<string, string>>): Record<string, string> {
  return { ...env, ...MICROVM_GUEST_ENV, ...MICROVM_PINNED_ENV };
}
