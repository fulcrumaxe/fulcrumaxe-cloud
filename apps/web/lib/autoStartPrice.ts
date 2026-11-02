import { CHILD_BUILD_SUPPORTED, FOLLOW_UP_CHILD_START_SUPPORTED, childFirstRunUsd, firstRunReservationUsd } from "@fx/pipeline";
import { childEnvelopeRoom } from "@fx/spend";
import type { CreateWorkerOptions } from "@fx/worker";

/**
 * D#483 S5-b1a-2: the one price the auto-start gate asks of the pipeline, handed to the worker (which cannot import @fx/pipeline). It lives here, not in
 * lib/worker.ts, because that file may not mention anything money-shaped (packages/pipeline/test/runActions.test.ts).
 *
 * D#483 S5-b2c-1: the planned PR child launch's two outside pieces. `buildSupported` is the pipeline's code constant (the pairing guard: nothing starts until the
 * build can build a child). `room` is the parent's envelope room for the child's first run, p(executor) for the repo, decided under the envelope's lock.
 */
export const autoStartOptions: NonNullable<CreateWorkerOptions["autoStart"]> = {
  firstRunUsd: (client, input) => firstRunReservationUsd(client, input),
  /** D#483 S5-b2d-2a: the follow-up child producer's flag (false until the launch exists). */
  followUp: { childStartSupported: FOLLOW_UP_CHILD_START_SUPPORTED },
  child: {
    buildSupported: CHILD_BUILD_SUPPORTED,
    room: async (client, input) => {
      const priceUsd = await childFirstRunUsd(client, { accountId: input.accountId, repoId: input.repoId });
      const room = await childEnvelopeRoom(client, { accountId: input.accountId, envelopeId: input.envelopeId, childId: input.childId, firstRunUsd: priceUsd });
      return { fits: room.fits, remainingUsd: room.remainingUsd, priceUsd };
    },
  },
};
