export {
  fanOutPendingEvents,
  claimDueDeliveries,
  sendDueDeliveries,
  autoDisableStaleEndpoints,
  purgeOldRows,
  runSweep,
  nextApiSweepDueAt,
  RETRY_SCHEDULE_SECONDS,
  AUTO_DISABLE_AFTER_MS,
  DOMAIN_EVENTS_RETENTION_MS,
  WEBHOOK_DELIVERIES_RETENTION_MS,
  IDEMPOTENCY_KEYS_RETENTION_MS,
  RATE_LIMIT_WINDOWS_RETENTION_MS,
  type ClaimedDelivery,
  type SendOutcome,
  type DeliverySender,
  type SweepSummary,
} from './sweep.js';
export { computeAdoptionStats, type AdoptionStats } from './adoption.js';

// D#31 API-4b
export {
  validateWebhookUrlSyntax,
  resolveDeliveryAddresses,
  InvalidWebhookUrlError,
  MAX_WEBHOOK_URL_LENGTH,
  type WebhookUrlReasonClass,
} from './ssrf.js';
export { deliver, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RESPONSE_BYTES, type DeliverRequest, type ConnectorOutcome } from './connector.js';
export {
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_VERSION,
  type WebhookSignatureHeaders,
} from './sign.js';
export {
  envWebhookKekSource,
  sealWebhookSecret,
  openWebhookSecret,
  generateWebhookSecret,
  type KekSource as WebhookKekSource,
  type SealedWebhookSecret,
} from './secrets.js';
export {
  WEBHOOK_EVENT_TYPES,
  isKnownWebhookEventType,
  sanitizeWebhookPayload,
  REPO_FULL_NAME_RE,
  GITHUB_URL_PREFIX,
  type WebhookEventType,
} from './payload.js';
export {
  createDeliverySender,
  sendTestEvent,
  type WebhookEndpointSecretMaterial,
  type DispatcherOpts,
} from './dispatcher.js';

// D#454 H3c
export {
  API_SWEEP_KICK_HEADER,
  API_SWEEP_KICK_BODY,
  API_SWEEP_KICK_PATH,
  KICK_DELAY_MS,
  KICK_COOLDOWN_MS,
  apiSweepKickKey,
  apiSweepKickHeader,
  verifyApiSweepKick,
  createApiSweepKicker,
  apiSweepKickerFromEnv,
  type ApiSweepKickerOptions,
} from './kick.js';
