/**
 * The site kit preview's limits (D#3 K10). The model cap is the same number the onboarding preview uses
 * (`PREVIEW_MODEL_CAP_USD`, checked against it in a test), and the model spend is on the customer's own key.
 * The compute is ours: capped per preview, and capped per day across all site-kit previews, counted apart from onboarding's.
 */
export const SITEKIT_PREVIEW_MODEL_CAP_USD = 20;
export const SITEKIT_PREVIEW_COMPUTE_CAP_USD = 1;
export const SITEKIT_PREVIEW_DAILY_COMPUTE_CAP_USD = 10;
/** The extract pass may use up to this much of the model cap; the verify pass gets whatever is left. */
export const EXTRACT_SHARE_USD = 14;
/** The label every locked feature shows. */
export const SETUP_PAYMENT_REQUIRED = "Setup payment required";
