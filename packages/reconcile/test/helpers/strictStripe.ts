// The strict Stripe fake lives in @fx/billing's test helpers (D#845 ON-22a): billing's own tests need it, and reconcile already depends on billing, so this direction closes no import cycle.
export * from '../../../billing/test/helpers/strictStripe.js';
