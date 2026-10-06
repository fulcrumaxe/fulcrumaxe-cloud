-- Site-kit approval (D#3 K07a). Two guards the approval library relies on,
-- both plain SECURITY INVOKER triggers, so neither needs a privilege grant.
--
-- 1. Freeze after approval. 0100_sitekit.sql:274 lets app_user UPDATE
--    report/approved_by/approved_at/published_at on site_versions. Once a
--    version is approved, the bytes the customer signed off on are described
--    by that report, so it must stop moving: report, approved_by and
--    approved_at become immutable, and published_at may go from NULL to a
--    value exactly once. Applies to every role, platform_ops included.
--    (K04's CHECK - published_at needs approved_by - is untouched.)
--
-- 2. attestations.source_hash. Carry-forward needs to know which claim
--    source an attestation was given against, and claims.source_hash keeps
--    only the latest value. The column is stamped from the claim row by a
--    trigger on INSERT, so a caller cannot choose it. Rows that pre-date
--    this migration stay NULL and are never carried forward (fail closed).

CREATE FUNCTION site_versions_freeze_after_approval() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.approved_by IS NOT NULL OR OLD.approved_at IS NOT NULL THEN
    IF NEW.report IS DISTINCT FROM OLD.report
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'site_versions % is approved: report, approved_by and approved_at are frozen', OLD.id
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'site_versions % is published: published_at is write-once', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER site_versions_freeze_after_approval
  BEFORE UPDATE ON site_versions
  FOR EACH ROW EXECUTE FUNCTION site_versions_freeze_after_approval();

ALTER TABLE attestations ADD COLUMN source_hash text;

CREATE FUNCTION attestations_stamp_source_hash() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.source_hash := (
    SELECT c.source_hash FROM claims c
    WHERE c.id = NEW.claim_id AND c.account_id = NEW.account_id
  );
  RETURN NEW;
END
$fn$;

CREATE TRIGGER attestations_stamp_source_hash
  BEFORE INSERT ON attestations
  FOR EACH ROW EXECUTE FUNCTION attestations_stamp_source_hash();
