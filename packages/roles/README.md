# @fx/roles

The 26 ported role cards (`cards/*.md`), the manifest that pins each one's
trigger/model/mode/cost-cap/browser-need (`src/manifest.ts`), and the hosted
tool registry each card's prose is checked against (`src/tools.ts`,
`src/next-role-request.ts`). See the test suite for what's enforced
mechanically; this file is for what the orchestrator (H09/H14/H15) has to
implement that a card can only describe, not enforce.

## Requirements for the orchestrator (H15)

### Consensus-panel challenge-round cap (project-manager, Phase 2)

The `project-manager` card requests a challenge round in its
`next_role_request` whenever a Round-1 or challenge-round synthesis draws a
challenge. It does **not** track how many rounds have already run — a
project-manager instance is a dynamic role restarted on every resume, not the
persistent-in-memory PM the engine original had, so nothing survives between
its own turns to count against. Counting has to happen somewhere that does
survive: the orchestrator.

**The orchestrator must:**
1. Track, per work item, how many challenge rounds have run for the current
   consensus panel.
2. Refuse to start a third challenge round for the same work item — do not
   start the roles the request named.
3. On refusal, resume the project-manager with `ResumeContext` (exported
   from `src/next-role-request.ts`) set to `{ cause: "request_refused",
   reason: "<why>" }` — not a silent drop, and not free-text in place of
   `cause`. The card branches on `cause`, so the orchestrator's emitted
   value and the card's expected value have to be the same three strings.
   The card treats `"request_refused"` the same as `"timeout"`: proceed to
   "On exit" with whatever confirmations/challenges exist so far — never the
   same as `"child_result"` with all-confirmed, because a refusal means the
   round budget ran out, not that consensus was reached.

`ResumeContext` (`src/next-role-request.ts`) is the typed resume cause the
orchestrator must attach to **every** resumed run, not just a refused one —
named the same way H09 names a denied spend reservation's status
(`refused_spend`, not a bare boolean or free-text reason):

```ts
export type ResumeCause = "child_result" | "timeout" | "request_refused";

export interface ResumeContext {
  cause: ResumeCause;
  reason?: string; // required in practice for "request_refused"
}
```

- `cause: "child_result"` — a role the card requested has posted its result.
- `cause: "timeout"` — the configured wait elapsed with no (or an incomplete) result.
- `cause: "request_refused"` — the orchestrator declined to start a requested
  role (the challenge-round cap above is the first case of this); `reason`
  says why.

The cap itself is 2 challenge rounds total (the initial Round-1 synthesis
plus one challenge round, per the original Spec's "max 1 extra round" — now
enforced here instead of in the card). The project-manager card independently
marks each challenge-round synthesis comment with its own round number (an
inline `<!-- CHALLENGE_ROUND:{N} -->` marker, read back only from comments
under the card's own author identity) so a resumed PM can recover which round
it's on without relying on memory — this is belt-and-braces legibility for a
human watching the run, not a substitute for the orchestrator's cap: an
edited or missing marker makes that number unreliable, and only the
orchestrator's count is authoritative.
