/**
 * D#483 S5-k2: the three ways a provider says "your credits ran out" on a generation call, and the near misses that must NOT be read that way.
 * Shared by the classifier test, the model-call test and the runner test (a relative import, the way the reconcile tests reuse the strict providers),
 * so one fixture per provider is held to one classification everywhere.
 *
 * Not faked faithfully (the PR says so): the exact wording of the gateway's 402 body (the classifier needs only the status), and the providers' other
 * error fields. The status codes and the Anthropic and OpenAI markers are the documented ones.
 */
export interface ProviderErrorAnswer {
  name: string;
  provider: 'ai_gateway' | 'anthropic' | 'openai';
  status: number;
  body: unknown;
}

export const CREDITS_EXHAUSTED_ANSWERS: readonly ProviderErrorAnswer[] = [
  { name: 'AI Gateway HTTP 402', provider: 'ai_gateway', status: 402, body: { error: { message: 'Insufficient credits', type: 'insufficient_funds' } } },
  {
    name: 'Anthropic credit-balance error',
    provider: 'anthropic',
    status: 400,
    body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } },
  },
  {
    name: 'OpenAI 429 insufficient_quota',
    provider: 'openai',
    status: 429,
    body: { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } },
  },
];

/** Answers that look close and are NOT an empty balance: they stay what they were (rate limit, bad request, rejected key, outage). */
export const NOT_CREDITS_ANSWERS: readonly ProviderErrorAnswer[] = [
  { name: 'OpenAI 429 rate limit', provider: 'openai', status: 429, body: { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } } },
  { name: 'Anthropic 429 rate limit', provider: 'anthropic', status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your rate limit' } } },
  { name: 'Anthropic 400 bad request', provider: 'anthropic', status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be greater than 0' } } },
  { name: 'Anthropic 401', provider: 'anthropic', status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } },
  { name: 'AI Gateway 403', provider: 'ai_gateway', status: 403, body: { error: { message: 'Forbidden' } } },
  { name: 'AI Gateway 500', provider: 'ai_gateway', status: 500, body: { error: { message: 'Internal error' } } },
  // The wording on the wrong status is not this answer either: a 500 that merely quotes the phrase is a server fault.
  { name: 'a 500 that quotes insufficient_quota', provider: 'openai', status: 500, body: { error: { message: 'upstream said insufficient_quota' } } },
];

/** The text a sandbox run reports for a provider error, which is what the runner classifies. */
export const eventTextFor = (a: ProviderErrorAnswer): string => `API Error: ${a.status} ${JSON.stringify(a.body)}`;
