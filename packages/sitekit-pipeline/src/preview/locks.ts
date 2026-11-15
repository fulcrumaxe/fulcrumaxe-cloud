import { SETUP_PAYMENT_REQUIRED } from "./constants.js";
import { PreviewError } from "./errors.js";

export const LOCKED_FEATURES = ["full_site", "downloads", "publish"] as const;
export type LockedFeature = (typeof LOCKED_FEATURES)[number];

export type FeatureLock = { locked: true; label: typeof SETUP_PAYMENT_REQUIRED } | { locked: false; label: null };

/** What the preview leaves locked. `setupPaid` is the billing package's `isSetupPaid` for this site; nothing else unlocks a feature. */
export function previewLocks(setupPaid: boolean): Record<LockedFeature, FeatureLock> {
  const lock: FeatureLock = setupPaid === true ? { locked: false, label: null } : { locked: true, label: SETUP_PAYMENT_REQUIRED };
  return { full_site: lock, downloads: lock, publish: lock };
}

/** Throws `setup_payment_required` unless setup is paid. Anything but the boolean `true` is unpaid. */
export function assertUnlocked(feature: LockedFeature, setupPaid: boolean): void {
  if (!LOCKED_FEATURES.includes(feature) || previewLocks(setupPaid)[feature].locked) throw new PreviewError("setup_payment_required");
}
