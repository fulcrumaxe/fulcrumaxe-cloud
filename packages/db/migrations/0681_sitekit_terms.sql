-- D#3 K09c: terms acceptance for site-kit payments, stored per product.
-- The hosted path records when the customer ticked the no-refunds terms and
-- which wording (accounts.terms_accepted_at / terms_policy_version, 0660). The
-- site-kit webhook records the same pair on the site's entitlement row, one
-- pair for the setup payment and one for the sync subscription, in the same
-- transaction as the paid-state write. Nullable: a row with no acceptance
-- simply has none on file.
-- No grant changes: platform_ops already has table-level UPDATE on
-- sitekit_entitlements (0679), which covers new columns; app_user stays
-- SELECT only and the row policies are unchanged.

ALTER TABLE sitekit_entitlements
  ADD COLUMN setup_terms_accepted_at   timestamptz,
  ADD COLUMN setup_terms_policy_version text,
  ADD COLUMN sync_terms_accepted_at    timestamptz,
  ADD COLUMN sync_terms_policy_version text;
