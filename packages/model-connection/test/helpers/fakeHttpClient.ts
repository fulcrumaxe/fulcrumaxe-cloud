import type { ValidationHttpClient, ValidationOutcome, ValidationRequest } from '../../src/httpClient.js';

export interface FakeHttpClient extends ValidationHttpClient {
  calls: ValidationRequest[];
}

/**
 * Criterion 3's injectable HTTP client (zero tokens). `outcomeOrFn` is a
 * fixed outcome or a function of the request. Every call is recorded in
 * `.calls`, so a test can assert the network step never ran (e.g. an
 * unauthorized connect()).
 */
export function fakeHttpClient(
  outcomeOrFn: ValidationOutcome | ((req: ValidationRequest) => ValidationOutcome | Promise<ValidationOutcome>),
): FakeHttpClient {
  const calls: ValidationRequest[] = [];
  return {
    calls,
    async validate(req: ValidationRequest): Promise<ValidationOutcome> {
      calls.push(req);
      return typeof outcomeOrFn === 'function' ? await outcomeOrFn(req) : outcomeOrFn;
    },
  };
}

/**
 * A client whose `validate()` hangs until released -- pins the exact
 * moment validateConnection() is between "read the key" and "write the
 * result" (test/toctou.test.ts) so a rotation attempt can land in that
 * window. `started` resolves the instant `validate()` is called.
 */
export function gatedHttpClient(): FakeHttpClient & { started: Promise<void>; release: (outcome: ValidationOutcome) => void } {
  const calls: ValidationRequest[] = [];
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let releaseFn!: (outcome: ValidationOutcome) => void;
  const gate = new Promise<ValidationOutcome>((resolve) => {
    releaseFn = resolve;
  });
  return {
    calls,
    started,
    release: releaseFn,
    async validate(req: ValidationRequest): Promise<ValidationOutcome> {
      calls.push(req);
      resolveStarted();
      return gate;
    },
  };
}
