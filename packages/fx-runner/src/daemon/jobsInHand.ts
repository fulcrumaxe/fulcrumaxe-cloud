/**
 * How many jobs this runner holds right now (D#6 C43-3). A count, not a flag: with several jobs in hand the first one to finish
 * must not clear the answer "a job is in hand" for the others. Self-update asks `any()` and acts only when it is false.
 */
export interface JobsInHand {
  /** Runs `job` and counts it as in hand from before it starts until it settles, however it ends. */
  track<T>(job: () => Promise<T>): Promise<T>;
  count(): number;
  any(): boolean;
}

export function createJobsInHand(): JobsInHand {
  let inHand = 0;
  return {
    async track(job) {
      inHand += 1;
      try {
        return await job();
      } finally {
        inHand -= 1;
      }
    },
    count: () => inHand,
    any: () => inHand > 0,
  };
}
