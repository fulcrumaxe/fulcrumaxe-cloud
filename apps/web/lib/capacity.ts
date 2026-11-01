import type { Pool } from "pg";
import { createCapacityPort } from "@fx/pipeline";
import { hostedSandboxSlotTotal } from "@fx/plan-data";
import { reportError } from "@fx/telemetry";
import { opsAlertSinkFromEnv } from "./opsAlertSink";

/**
 * D#483 S5-k3b-2c: the capacity queue the worker's gate asks (packages/worker capacityGate.ts), built on the runner pool the worker owns.
 *  - The slot total comes from plan data and nowhere else (`hostedSandboxSlotTotal` throws when it has no figure; the gate then counts nothing and health names the key).
 *  - The depth alert goes through the existing ops alert path (`opsAlertSinkFromEnv`, the one the reconcile and invariant crons use). With no sink configured it is simply not sent.
 */
export function createCapacity(pool: Pool): ReturnType<typeof createCapacityPort> {
  return createCapacityPort({
    pool,
    slotTotal: hostedSandboxSlotTotal,
    alert: async (text) => {
      const sink = opsAlertSinkFromEnv();
      if (sink) await sink.send({ kind: "invariant", text });
    },
    onAlertError: (err) => reportError(err, { stage: "capacity.depth_alert" }),
  });
}
