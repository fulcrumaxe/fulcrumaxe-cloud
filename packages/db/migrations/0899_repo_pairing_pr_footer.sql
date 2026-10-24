-- Repo pairing: an optional footer template for the public pull request body, set by an owner or admin with the rest of the pairing.
--
-- NULL means no footer (today's body). The text is one line of at most 200 characters; the API refuses everything else it checks (unknown placeholders,
-- links, secret-shaped text), and this constraint keeps the shape sane for any other writer. The footer is NOT part of the pairing digest, so editing it
-- never invalidates a build in flight; it is read when the pull request text is built.
--
-- Expand-only: one nullable column, no default, nothing read by an older build. Numbered above the highest migration queued on the code plane (0898, an open pull request).
-- Re-check right before the pull request is opened and again before merging.

ALTER TABLE repo_pairing
  ADD COLUMN pr_footer text
    CONSTRAINT repo_pairing_pr_footer_check CHECK (pr_footer IS NULL OR (char_length(pr_footer) BETWEEN 1 AND 200 AND pr_footer !~ '[[:cntrl:]]'));
