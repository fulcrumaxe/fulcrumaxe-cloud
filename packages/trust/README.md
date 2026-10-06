# @fx/trust

Untrusted-text provenance gate: author-trust classification
(`classifyAuthor`, `canCreateWork`), control-token sanitization and
fencing (`sanitize`, `stripControlTokens`), and the work-creation /
auto-merge gates that consume them (`storeWorkEvent`, `autoMergeAllowed`).

See the docstrings in `src/sanitize.ts`, `src/author-trust.ts` and
`src/work-gate.ts` for what each function does and why. This file holds
the requirements that bind CALLERS of this package, not this package's
own behavior — recorded here, in code, so H13 (GitHub webhooks / proxy),
H14 (pipeline steps 5-8: executor, reviews, fix loop, merge gate), H15
(pipeline steps 1-4: intake, triage, panel, spec) and H22 (intelligent
model routing / prompt budget) inherit them from the package they import,
rather than from a review report nobody re-reads once it's resolved.

## Pipeline requirements

1. **`sanitize()` takes exactly one author's text per call. Never a
   concatenation.** Concatenating several authors' comments, issue
   bodies, or CI output into one `sanitize()` call is unsafe regardless
   of length: one author's stray unterminated `<!--` swallows every
   subsequent author's text in the same call, because the HTML-comment
   pattern's end-of-string fallback has no way to know where the next
   author's text begins. Call `sanitize()` once per comment/body/field,
   not once per batch. See `SANITIZE_MAX_INPUT_LENGTH`'s docstring in
   `src/sanitize.ts` for the exact failure shape.

2. **Re-resolve permission and allowlist per event, every time.**
   `classifyAuthor` / `canCreateWork` take `repoPermission` and
   `allowlist` as plain inputs — they do not fetch or cache anything
   themselves. A caller that resolves permission once and reuses it
   across multiple later events (a comment stream, a re-scan) reintroduces
   the exact staleness `storeWorkEvent`'s statelessness was built to
   avoid (Spec H07 #5, the R3 mid-flight re-check): a maintainer who is
   removed from the repo, or a login that changes permission mid-thread,
   must be re-checked on every event, not assumed from an earlier read.

3. **`WorkEvent` only carries `body`. Sanitize titles, labels, branch
   names, commit messages and CI output too.** This package's trust
   decision (`classifyAuthor`) already ignores body text by construction
   — the type has no body field. But `sanitize()`/`stripControlTokens()`
   only ever see what a caller passes them. A PR title, a label name, a
   branch name, a commit message, and CI output are all untrusted text
   from the same threat model as a comment body, and none of them flow
   through `WorkEvent.body` — a caller building a prompt from any of
   those fields MUST run it through `sanitize()` separately. This package
   does not do it for you.

4. **The DB boundary uses `parseProvenance` — don't pass a loosely-typed
   value through to `autoMergeAllowed` and hope.** `autoMergeAllowed`
   treats anything that isn't the exact string `"internal"` as external
   (fail-closed by design — see its docstring in `src/work-gate.ts`),
   which is safe as a last line of defense but means a bug upstream (a
   typo, a wrong case, a `null` from an unvalidated DB row) silently
   produces the SAME "treat as external" outcome as a deliberately
   external item, with no signal that something upstream was wrong.
   `parseProvenance(value: unknown): Provenance` (`src/provenance.ts`) is
   the one function every read of a `work_items.provenance` column goes
   through before the value reaches `autoMergeAllowed`; it returns exactly
   `"internal"` or `"external"` and throws `ProvenanceError` for anything
   else — never trim, never lower-case, never add a second mapping
   function. The column's own CHECK constraint holds exactly those two
   literals, `CHECK (provenance IN ('internal','external'))`
   (`packages/db/migrations/0608_work_items_provenance_vocabulary.sql`),
   so `external` at the DB boundary only ever means "genuinely external,"
   not "something else went wrong."

5. **Never wrap `autoMergeAllowed` in a `try`/`catch` that returns `true`
   on error.** This is the one decision in this package that gates an
   unattended merge into a customer's repo. `autoMergeAllowed` never
   throws for any input shape (it uses `===` comparisons against `unknown`
   fields, not property access chains that could throw) — but if a future
   change to a caller wraps the call anyway "to be safe," the catch
   branch must never return `true`. A caught exception here is exactly as
   dangerous as a fail-open bug, and defeats the whole point of this
   function's fail-closed design.

6. **H22 (model routing) owns the prompt budget, not this package.**
   `sanitize()`'s `SANITIZE_MAX_INPUT_LENGTH` bound (200,000 characters)
   protects `sanitize()` itself from unbounded work — it is not a prompt
   budget, and callers must not treat it as one. NFKC normalization alone
   can expand a string by roughly 18x (measured): 200,000 characters in
   can become on the order of 3,600,000 characters (~3.6MB) of
   `storedBody` out. H22's per-role prompt budget is what must decide how
   much of a long `storedBody` actually reaches a model prompt.

7. **Display `rawBody`. Prompt from `storedBody`.** `storeWorkEvent`
   returns both. `rawBody` is byte-identical to what the author wrote —
   use it for anything a human reads (a comment view, an audit log, a
   diff). `storedBody` is sanitized/fenced/NFKC-normalized for an
   untrusted author — use it for anything that becomes part of a model
   prompt. Never build a prompt from `rawBody`, and never show `storedBody`
   to a human as "what they wrote" — NFKC rewrites content ("x² + ½"
   becomes "x2 + 1/2"), so it is not.
