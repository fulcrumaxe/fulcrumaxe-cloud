export const RUN_ACTION_KINDS = ['cancel_run', 'cancel_work_item', 'retry_run', 'continue_work_item', 'start_preview', 'advance_work_item', 'respec_work_item'] as const;
export type RunActionKind = (typeof RUN_ACTION_KINDS)[number];

export interface RunActionMessage {
  actionId: string;
  accountId: string;
  kind: RunActionKind;
}

/**
 * Speeds up processing of a run action; nothing more. The `run_action_requests`
 * row is the durable signal and a sweep picks up anything a lost kick leaves
 * behind, so an implementation is untrusted and may drop, delay or fail. It
 * carries ids only.
 */
export interface RunActionSignal {
  signal(msg: RunActionMessage): Promise<void>;
}

/** Test fake: records every message it is handed. */
export function createRecordingRunActionSignal(): RunActionSignal & { readonly sent: RunActionMessage[] } {
  const sent: RunActionMessage[] = [];
  return {
    sent,
    async signal(msg) {
      sent.push(msg);
    },
  };
}
