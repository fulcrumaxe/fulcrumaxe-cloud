// D#2605 H21: customer model connection (bring your own key). Package-only
// (see this PR's description) -- no route, no page. D#31 comment 18494573
// (C6) freezes this package's exported surface to exactly four ctx-taking
// functions (getStatus, connect, test, remove) plus markBroken/
// createConnectionStatusPort (a different calling convention -- see
// markBroken.ts) and the generic seal/open envelope primitives.

export type { Provider, ConnectionStatus, ConnectionStatusView, ModelConnectionCtx, Principal } from './types.js';
export { isAnthropicProviderEnabled, buildAad } from './types.js';

export { NotFoundError, ForbiddenError, InvalidModelKeyError, DecryptionFailedError } from './errors.js';

export type { KekSource } from './kek.js';
export { envKekSource } from './kek.js';

export type { KekAad, Sealed } from './crypto.js';
export { seal, open, fingerprintOf } from './crypto.js';

export type { ValidationRequest, ValidationOutcome, ValidationHttpClient } from './httpClient.js';
export { fetchValidationHttpClient } from './httpClient.js';

export type { ConnectParams } from './connect.js';
export { connect } from './connect.js';

export { remove } from './remove.js';

export { getStatus } from './summary.js';

export type { HealthCheckCtx, HealthCheckResult } from './validate.js';
export { test, healthCheck } from './validate.js';

export type { BrokenConnectionCode, ConnectionStatusPort } from './markBroken.js';
export { markBroken, markBrokenWithClient, createConnectionStatusPort } from './markBroken.js';

export type { PlanPathKind } from './planKinds.js';
export { PLAN_PATH_KINDS, NOTICE_VERSIONS, isPlanPathKind, assertPlanPathKind, UnknownPlanKindError } from './planKinds.js';

export type { KindSwitchState, SetKindEnabledResult } from './killSwitch.js';
export {
  KILL_SWITCH_REFUSAL_REASON,
  isKindEnabled,
  isKindEnabledWithClient,
  listKindSwitches,
  setKindEnabled,
} from './killSwitch.js';

export type { NoticeAckCtx, NoticeAckView } from './noticeAck.js';
export { recordAcknowledgement, hasAcknowledgement, hasAcknowledgementWithClient } from './noticeAck.js';
