/**
 * D#31 AUTHOR-CHECK-WIRE: the one source of the allowlist of GitHub logins trusted whatever their
 * repository permission. Webhook intake and the retry author check both read it, so they cannot
 * drift apart. Nothing configures one today: null, which both consumers read as an empty list.
 *
 * If a customer-level intake setting (an allowlist, or a write-permission opt-in) is ever added,
 * add it HERE so both consumers get it. The retry write floor (RETRY_AUTHOR_WRITE_FLOOR) stays a
 * constant unless D#31 criterion 7 is amended. If a per-account allowlist is ever added, the
 * provider's signature must take the account id; that is a later task.
 */
let override: readonly string[] | null | undefined;

export function intakeAllowlist(): readonly string[] | null {
  return override === undefined ? null : override;
}

/** Test seam: swap the list; call with no argument to restore. */
export function setIntakeAllowlistForTests(list?: readonly string[] | null): void {
  override = list;
}
