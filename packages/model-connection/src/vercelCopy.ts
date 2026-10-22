import type { VercelConnectionErrorCode, VercelConnectionState } from './vercelConnection.js';

/**
 * D#598 P8d-2: the words for the "connect Vercel" connection, one entry per state, so the screen shows what the connection actually is and never
 * a blank or an internal label. Owner-delegated copy (the owner can revise); plain sentences, no token, no code names.
 * `{tail}` is the token's display fingerprint (four hex characters of a keyed hash, not characters of the token); {@link vercelStateCopy} fills it.
 */
export interface VercelStateCopy {
  headline: string;
  detail: string;
  /** The main button, or null when there is nothing to press. */
  action: string | null;
  /** The quieter button (disconnect), or null. */
  secondaryAction: string | null;
}

const STATE_COPY: Record<VercelConnectionState, VercelStateCopy> = {
  not_connected: {
    headline: 'Vercel is not connected',
    detail: 'Connect Vercel and we can check that your project has the environment variables a step asks for. We read variable names only, never their values.',
    action: 'Connect Vercel',
    secondaryAction: null,
  },
  connected: {
    headline: 'Vercel is connected',
    detail: 'Your token (fingerprint {tail}) is in use. We read variable names only, never their values.',
    action: 'Replace token',
    secondaryAction: 'Disconnect',
  },
  rejected: {
    headline: 'Vercel is not accepting your token',
    detail: 'The token (fingerprint {tail}) was refused. It may have expired or been revoked. Until you replace it, we cannot check your environment variables for you.',
    action: 'Replace token',
    secondaryAction: 'Disconnect',
  },
};

export function vercelStateCopy(state: VercelConnectionState, tail: string | null): VercelStateCopy {
  const copy = STATE_COPY[state];
  return { ...copy, detail: copy.detail.replace('{tail}', tail ?? '') };
}

/** The rotate flow, and the line for each way a connect or replace can be refused. */
export const VERCEL_ROTATE_COPY = {
  prompt: 'Paste a new Vercel token. The current one stays in use until Vercel accepts the new one.',
  success: 'Token replaced.',
  disconnected: 'Vercel is disconnected.',
} as const;

export const VERCEL_ERROR_COPY: Record<VercelConnectionErrorCode, string> = {
  invalid_token_format: "That doesn't look like a Vercel token. Paste it again without spaces.",
  invalid_team_id: "That doesn't look like a Vercel team id. It starts with team_.",
  token_rejected: "Vercel didn't accept that token. Check that it hasn't expired and can see your projects.",
  provider_unreachable: "We couldn't reach Vercel to check that token. Try again in a minute.",
  already_connected: 'Vercel is already connected. Use Replace token to change it.',
  not_connected: 'Vercel is not connected yet.',
};
