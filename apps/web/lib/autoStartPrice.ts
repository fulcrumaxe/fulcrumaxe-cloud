import { firstRunReservationUsd } from "@fx/pipeline";
import type { CreateWorkerOptions } from "@fx/worker";

/**
 * D#483 S5-b1a-2: the one price the auto-start gate asks of the pipeline, handed to the worker (which cannot import @fx/pipeline). It lives here, not in
 * lib/worker.ts, because that file may not mention anything money-shaped (packages/pipeline/test/runActions.test.ts).
 */
export const autoStartOptions: NonNullable<CreateWorkerOptions["autoStart"]> = {
  firstRunUsd: (client, input) => firstRunReservationUsd(client, input),
};
