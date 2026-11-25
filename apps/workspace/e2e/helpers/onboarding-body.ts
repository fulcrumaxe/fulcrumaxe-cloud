// apps/workspace/e2e/helpers/onboarding-body.ts
//
// D#845 ON-6: the Onboarding app and the shell read the pipeline track from `tracks[0]`, so a mocked GET /api/v1/onboarding body that edits the pipeline
// steps has to edit them there (the top-level `steps` is the same list for readers that have not moved). These helpers keep the two in step.

type Step = Record<string, unknown>;
type Track = { track: string; steps: Step[]; chosen_at: string | null };
export type OnboardingBody = { steps: Step[]; tracks: [Track, Track] } & Record<string, unknown>;

const CHOSEN = "2026-09-20T08:30:00.000Z";

/** The body with its pipeline steps replaced, in both places the API carries them. */
export const withSteps = <B extends OnboardingBody>(body: B, steps: Step[]): B => ({ ...body, steps, tracks: [{ ...body.tracks[0], steps }, body.tracks[1]] });

/** The body with the given tracks marked as chosen (the engine's steps are kept as they are). */
export const withChosen = <B extends OnboardingBody>(body: B, which: { pipeline?: string | null; engine?: string | null }): B => ({
  ...body,
  tracks: [
    { ...body.tracks[0], chosen_at: which.pipeline === undefined ? body.tracks[0].chosen_at : which.pipeline },
    { ...body.tracks[1], chosen_at: which.engine === undefined ? body.tracks[1].chosen_at : which.engine },
  ],
});

/** An account that chose the pipeline track: what every test written before the engine track starts from. */
export const pipelineChosen = <B extends OnboardingBody>(body: B): B => withChosen(body, { pipeline: CHOSEN });

/** An account that chose only the pipeline track (the contract fixtures of later steps also record the engine track as chosen). */
export const pipelineOnly = <B extends OnboardingBody>(body: B): B => withChosen(body, { pipeline: CHOSEN, engine: null });

/** The engine track with each named step in the given state (the first step not named is pending), the way ON-5 derives them. */
export function engineTrack(states: Record<string, string>, extra: { tier?: string | null; code?: string; kvm?: "present" | "absent"; helper_missing?: true; install?: { setup_id: string; pr_number: number; pr_state: string } } = {}): Step[] {
  const T = "2026-11-20T10:00:00.000Z";
  return ["machine", "claude", "github_app", "project", "plan", "install", "live"].map((step) => {
    const state = states[step] || "pending";
    return { step, state, completed_at: state === "done" ? T : null, tier: step === "machine" ? extra.tier ?? null : null, ...(step === "machine" && extra.kvm ? { kvm: extra.kvm } : {}), ...(step === "machine" && extra.helper_missing ? { helper_missing: true } : {}), ...(step === "install" && extra.install ? extra.install : {}), failure: state === "failed" ? { code: extra.code ?? "survey_failed", at: T } : null };
  });
}

/** The body with the engine track's steps replaced. */
export const withEngine = <B extends OnboardingBody>(body: B, steps: Step[], chosen: string | null = CHOSEN): B => ({
  ...body,
  tracks: [body.tracks[0], { ...body.tracks[1], steps, chosen_at: chosen }],
});
