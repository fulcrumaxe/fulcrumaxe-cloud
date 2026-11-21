/**
 * D#587 B-5b-3c-iii: the parts of the live microVM stack that only the machine can supply, made from what `bin/fx-runner.mjs` hands in: the boot facts over the signed release listing and
 * the installed manifest, the template and its RAM, the guest agent runtime with its per-sandbox bindings, and the model token's reader. Nothing here reads `process.*`, a file or the
 * clock: the entry point reads the uid, the helper socket path, the installed manifest, the clock and the token's variable, and a test passes fakes. `createLiveMicrovm` wires the stack only
 * when every part is present and usable, so nothing here is optional and nothing falls back.
 */
import { createBootFactsSource, type BootFactsOptions } from "./bootFacts.js";
import { SMALLEST_TEMPLATE_RAM_MB } from "./install.js";
import { TEMPLATES } from "./lock.js";
import { GuestBindings, GuestRunHooks } from "./sandboxd/guestBindings.js";
import { guestMakeRuntime } from "./sandboxd/guestRuntime.js";
import type { LiveMicrovmParts } from "./sandboxd/live.js";
import { productionDepsBase } from "./sandboxd/production.js";
import type { EgressStarters } from "./sandboxd/policyPort.js";

export interface MicrovmPartsHost {
  /** The effective and real user ids, read once at the entry point (`undefined` where the platform has none). */
  euid: number | undefined;
  uid: number | undefined;
  platform: string;
  helperSocket: string;
  /** The signed listing (the runner's TUF client), the installed manifest's text, the node architecture name and the clock. */
  tuf: BootFactsOptions["tuf"];
  readManifest: BootFactsOptions["readManifest"];
  nodeArch: string;
  now: () => number;
  egress: EgressStarters;
  /** The directory a guest run's raw transcripts go to (the runner's own log directory, as the host engine's). Asked for when a run starts, not when the parts are made. */
  logDir: () => string;
  /**
   * The one read of the runner's model token for a VM run: a fresh buffer on each call, which the token step zeroes after the send. Empty means no token, and the token step then refuses
   * (`vm_token_delivery_failed`). The caller reads the environment; this module only passes the function on and never calls it. The token is never logged, kept or put in a message.
   */
  readToken: () => Buffer;
}

/** Every part of `LiveMicrovmParts`, present: the entry point cannot leave one out, and a test sees each by name. */
export type MicrovmParts = Omit<{ [K in keyof LiveMicrovmParts]-?: NonNullable<LiveMicrovmParts[K]> }, "uid"> & { uid: number | undefined };

export function createMicrovmParts(host: MicrovmPartsHost): MicrovmParts {
  const bindings = new GuestBindings();
  const shared = {
    credentials: { mode: "subscription" as const },
    // a getter: `guestMakeRuntime` spreads it when it builds a runtime for a start, so the directory is asked for then
    get logDir(): string {
      return host.logDir();
    },
  };
  return {
    deps: productionDepsBase({ helperSocket: host.helperSocket, host: { euid: host.euid, platform: host.platform as NodeJS.Platform } }),
    boot: createBootFactsSource({ tuf: host.tuf, template: TEMPLATES[0], nodeArch: host.nodeArch, readManifest: host.readManifest, now: host.now }),
    template: TEMPLATES[0],
    memMb: SMALLEST_TEMPLATE_RAM_MB,
    uid: host.uid,
    egress: host.egress,
    bindings,
    makeRuntime: guestMakeRuntime(shared, bindings.binding),
    readToken: host.readToken,
    runHooks: new GuestRunHooks(),
  };
}
