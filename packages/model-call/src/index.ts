// D#291 PI-2a: the server-side model-call seam (bring-your-own-key only).
export type { ModelCallCtx, CompleteJsonParams, CompleteJsonResult } from './completeJson.js';
export { completeJson } from './completeJson.js';
export { ModelCallError } from './keyUse.js';
export type { ModelCallErrorCode } from './keyUse.js';
export { MODEL_HOSTS } from './hosts.js';
