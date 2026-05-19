# UPGRADE-PLAN.md

Two-stage refactor of the feedback analysis flow, with per-cell Airtable
write-back from the UI.

This file is the spec for a Claude Code `/goal` run. Drop it in your repo at
`docs/UPGRADE-PLAN.md`, then run the `/goal` command at the bottom of this file
from inside `claude` in your repo's terminal.

---

## 0. Read this first — decision points you must resolve

Do not start the `/goal` run until you've answered these. The spec has sensible
defaults, but you own the trade-offs.

### Decision A — Stage 1 provider

The current `app/api/analyse-case/route.ts` forces OpenAI (`gpt-5.4`), not
Sonnet, despite the surrounding code supporting both providers. **Pick one:**

- **Recommended:** Anthropic Sonnet 4.6 (`claude-sonnet-4-6`). Reasons: native
  `allowed_domains` web search restricted to your `lib/guideline-domains.ts`
  whitelist, structured outputs via tool-use, removes OpenAI from this path.
- Keep OpenAI `gpt-5.4`. Faster on reasoning, but lose the domain whitelist
  guarantee.

The spec below assumes **Sonnet 4.6**. If you keep OpenAI, search the file for
`STAGE1_PROVIDER` and change accordingly.

### Decision B — Scope of Stage 2 (Opus rewrite)

You said "EVERY part of the case". This costs real money per feedback row.
**Pick one:**

- **Recommended:** Default to **flagged-only** (rewrite the fields Stage 1
  identified as problematic), with a UI toggle for "Rewrite whole case".
- Always rewrite the whole case (your stated preference, but expensive).

The spec implements **both** with a toggle. Default state of the toggle is
flagged-only; change `DEFAULT_REWRITE_SCOPE` if you want whole-case as default.

### Decision C — Cache invalidation

Cached Stage 1 findings can go stale if either (a) the case is edited in
Airtable, or (b) clinical guidelines update. **Pick one:**

- **Recommended:** Cache findings indefinitely, but always re-fetch case data
  from Airtable before Stage 2 runs (matches the pattern already used by
  `app/api/full-analysis/route.ts`). Add a "Re-run triage" button.
- Auto-expire cache after N hours.

Spec uses option 1.

### Decision D — Apply-edit safety

When the user clicks "Update Airtable" on a single suggestion, what should
happen if the current Airtable value differs from the `currentText` Stage 2
saw (i.e. someone edited it in Airtable between Stage 2 and the click)?

- **Recommended:** Refuse the write, surface the conflict to the user with
  both values, let them re-run Stage 2 or proceed manually.
- Overwrite anyway. (Dangerous — silent data loss.)

Spec uses option 1.

### Decision E — Airtable write token

The existing `AIRTABLE_FEEDBACK_WRITE_TOKEN` is scoped to the *feedback* base.
Writes from Stage 3 (apply-edit) target the *Cases* base. You will need to
either:

- **Recommended:** Create a new `AIRTABLE_CASES_WRITE_TOKEN` at
  https://airtable.com/create/tokens with `data.records:write` scope on the
  Cases base only. Keep it separate from the feedback write token.
- Expand the existing write token to cover both bases (broader blast radius).

The spec assumes a new env var `AIRTABLE_CASES_WRITE_TOKEN` is added.

---

## 1. Current state (what exists today)

For the agent's benefit — do not skip this section even if you wrote the code,
because the goal validator can only see what the model surfaces in the
transcript, so it helps for the model to restate the baseline.

- `app/api/analyse-case/route.ts` — single endpoint, forces OpenAI, returns
  verdict + fieldChanges + email response in one shot.
- `app/api/full-analysis/route.ts` — separate full-case audit, Sonnet 4.6,
  unchanged by this refactor.
- `lib/airtable.ts` `getCaseData()` — **merges every record of every field**
  into one string per field with `\n\n`. Destroys row identity. Must change.
- `lib/triage-store.ts` — Vercel Blob layer for the guideline audit dashboard
  (`/audit`). Pattern to copy for the new feedback analysis cache.
- `app/page.tsx` — feedback review UI. Single "Analyse" button per submission.
- No write path back to the Cases base.

## 2. Target architecture

Three stages, two new endpoints, one extension of an existing endpoint:

```
Stage 1: TRIAGE          Stage 2: REWRITE           Stage 3: APPLY
(Sonnet 4.6)             (Opus 4.7)                 (Airtable PATCH)

[Analyse button]   --->  [Generate rewrites btn]   ---> [Update btn per cell]
                              (only if Stage 1
                               flagged changes)

POST /api/feedback-triage    POST /api/draft-rewrites    POST /api/apply-edit
  - validate feedback         - load cached triage         - PATCH single field
  - web search guidelines     - re-fetch case (fresh)       on one Airtable
  - identify flagged areas    - Opus drafts per-cell        record
  - draft response email      - return list of edits      - returns 409 on
  - cache to blob             - cache to blob               conflict
```

## 3. Tasks (implement in this order)

The agent must complete every task. The goal is met when all acceptance
criteria in section 6 pass.

### Task 1 — Restructure case data fetching to preserve row identity

**File:** `lib/airtable.ts`

Add a new function alongside the existing `getCaseData()` (do not delete the
old one — `app/api/full-analysis/route.ts` and others still use it):

```ts
export interface CaseRowCell {
  recordId: string           // Airtable record ID, e.g. "rec123..."
  fieldName: string
  value: string
}

export interface CaseDataStructured {
  caseNumber: string
  tableName: string          // e.g. "Case 1"
  records: Array<{
    recordId: string
    rowIndex: number         // 0-based position for human-readable refs
    fields: Record<string, string>
  }>
}

export async function getCaseDataStructured(
  caseNumber: string,
): Promise<CaseDataStructured | null>
```

The function fetches the same `Case ${caseNumber}` table but returns each
record separately, preserving `recordId`. Pagination must work (current code
doesn't page; add `offset` handling for cases with >100 records — unlikely but
defensible).

Also add:

```ts
export async function updateCaseField(
  caseNumber: string,
  recordId: string,
  fieldName: string,
  newValue: string,
): Promise<void>
```

This PATCHes a single field on a single record in the Cases base. Use
`AIRTABLE_CASES_WRITE_TOKEN` (new env var). Throw with a clear message if the
token is unset. Use `typecast: false` (we want errors on schema mismatches,
not silent coercion).

Add a helper to fetch a single record's current value (for conflict detection
in Task 6):

```ts
export async function getCaseFieldValue(
  caseNumber: string,
  recordId: string,
  fieldName: string,
): Promise<string | null>
```

### Task 2 — Stage 1: `/api/feedback-triage`

**File:** `app/api/feedback-triage/route.ts` (new)

Replaces the front half of `analyse-case`. Responsibilities:

1. Accept `{ feedbackId, extraContext? }` in the POST body.
2. Look up the feedback row from Airtable (re-use `getAllFeedback()` filtered
   by ID, or add `getFeedbackById()` to `lib/airtable.ts`).
3. Fetch the case via `getCaseDataStructured()`.
4. Call Sonnet via `callTriageAI()` from `lib/ai-provider.ts` with a NEW system
   prompt focused only on:
   - Validating the feedback against current UK guidelines
   - Identifying WHICH `(recordId, fieldName)` pairs are clinically affected
   - NOT drafting suggested text (that's Stage 2's job)
   - Drafting the response email if `contactRegardingOutcome` is true
5. Return a new schema `FEEDBACK_TRIAGE_SCHEMA` (define in `lib/schemas.ts`):

```ts
{
  caseScenario: string
  summary: string
  sources: Array<{ title, url, finding }>
  verdict: 'valid' | 'partial' | 'invalid' | 'uncertain'
  verdictReason: string
  verdictSelfCheck: { ... }   // same self-check pattern as ANALYSE_CASE_SCHEMA
  flaggedCells: Array<{
    recordId: string
    fieldName: string
    rowIndex: number          // for human-readable display
    issue: string             // what's wrong, NOT a fix
    severity: 'high' | 'medium' | 'low'
  }>
  emailResponse: string       // or "No contact requested"
}
```

6. Cache the result to Vercel Blob via a new `lib/feedback-analysis-store.ts`
   (see Task 3), keyed by feedback record ID. Include a snapshot of the
   structured case data (so Stage 2 sees the same content Stage 1 reasoned
   over — important for the verdict to make sense even if Airtable changes).
7. Return the parsed result plus `_meta` block (provider, model, searchCount,
   citedUrls) in the same shape as `analyse-case` so the UI patch is small.

**Model:** Sonnet 4.6 (`claude-sonnet-4-6`). Provider: anthropic.
**Max searches:** 6 (same as current `analyse-case`).

### Task 3 — Cache layer for feedback analysis

**File:** `lib/feedback-analysis-store.ts` (new)

Mirror the API of `lib/triage-store.ts`. Two record types:

```ts
export interface FeedbackTriageRecord {
  feedbackId: string
  caseNumber: string
  triagedAt: string
  triage: FeedbackTriageResult         // the parsed Stage 1 output
  caseSnapshot: CaseDataStructured     // what Stage 1 saw
  citedUrls: string[]
  provider: string
  model: string
  searchCount: number
}

export interface FeedbackRewriteRecord {
  feedbackId: string
  draftedAt: string
  scope: 'flagged-only' | 'whole-case'
  rewrites: Array<{
    recordId: string
    fieldName: string
    rowIndex: number
    currentText: string
    suggestedText: string
    rationale: string
    confidence: 'high' | 'medium' | 'low'
    sourceUrl?: string
    appliedAt?: string                 // set when user clicks Update
  }>
  provider: string
  model: string
}
```

Functions:

```ts
saveTriage(record: FeedbackTriageRecord): Promise<void>
getTriage(feedbackId: string): Promise<FeedbackTriageRecord | null>
saveRewrites(record: FeedbackRewriteRecord): Promise<void>
getRewrites(feedbackId: string): Promise<FeedbackRewriteRecord | null>
markRewriteApplied(feedbackId: string, recordId: string, fieldName: string): Promise<void>
```

Fail loudly if `BLOB_READ_WRITE_TOKEN` is unset (same pattern as `triage-store.ts`).

### Task 4 — Stage 2: `/api/draft-rewrites`

**File:** `app/api/draft-rewrites/route.ts` (new)

1. Accept `{ feedbackId, scope: 'flagged-only' | 'whole-case' }`.
2. Load Stage 1 triage from blob. Return 404 if missing.
3. **Re-fetch** case via `getCaseDataStructured()` (do not trust the snapshot
   for the actual rewriting — guidelines may have moved on, and the user may
   have already manually edited some fields). Compare against `caseSnapshot`;
   note any cells that have changed since Stage 1.
4. Filter target cells:
   - `flagged-only` → only `triage.flaggedCells`
   - `whole-case` → every non-empty cell across every record
5. Call Opus 4.7 (`claude-opus-4-7`) via `callTriageAI()` with `providerOverride: 'anthropic'`.
   Pass the full case content (every record), the triage findings, the feedback,
   and the list of target cells. Tell it to return for each target cell:
   - The current text verbatim (for conflict detection later)
   - A drop-in replacement (`suggestedText`) — same prose style, no
     editing-instructions, copy/paste-ready
   - A short rationale tied to the guideline finding
   - A confidence level
   - The source URL backing the rewrite
6. Schema `DRAFT_REWRITES_SCHEMA` in `lib/schemas.ts`, mirroring the
   `FeedbackRewriteRecord.rewrites` shape.
7. Cache the result and return it.

**Model:** Opus 4.7. **Max searches:** 8 (Opus may want to re-check sources).
**Token budget:** start at 16000 max_tokens (full case + many rewrites).

**Guardrail:** if `scope === 'whole-case'` and the case has more than 80
non-empty cells, return a 413 with a clear message asking the user to switch
to flagged-only or split the request. Stops runaway costs.

### Task 5 — UI: per-cell suggestion table with inline edit + apply

**File:** `app/page.tsx` (modify)

Replace the existing single-shot Analyse flow with a two-step UI:

1. **Triage button** ("Check feedback") replaces "Analyse". On click, calls
   `/api/feedback-triage`. Shows verdict, summary, sources, email — same as
   today, but pulled from the new endpoint.
2. **Generate rewrites button** appears only when verdict is `valid` or
   `partial`. Includes a scope toggle (default: "Flagged sections only" /
   alt: "Whole case"). On click, calls `/api/draft-rewrites`.
3. **Rewrite table.** For each rewrite, a card with:
   - Header: `Record {rowIndex+1} · {fieldName}` and confidence pill
   - Rationale paragraph
   - Side-by-side `currentText` (red) | `suggestedText` (green, **editable
     textarea**)
   - Source URL link
   - "Update Airtable" button per card → calls `/api/apply-edit`
   - Status indicator: pending / applied (✓ with timestamp) / conflict (with
     the live value from Airtable shown alongside)
4. **Persist edits.** When the user edits the suggested text, debounce-save
   to the blob via a new lightweight `/api/save-rewrite-edit` endpoint or
   defer until the user clicks "Update Airtable" (simpler — pick this).

Re-use existing CSS modules where possible. The diff-card pattern in
`app/audit/page.tsx` is the right visual language; copy it.

### Task 6 — Stage 3: `/api/apply-edit`

**File:** `app/api/apply-edit/route.ts` (new)

1. Accept `{ feedbackId, recordId, fieldName, newValue }`.
2. Load the cached rewrite for `(feedbackId, recordId, fieldName)`. Return 404
   if missing.
3. **Conflict check (Decision D, option 1):** fetch the current Airtable value
   via `getCaseFieldValue()`. If it differs from the cached `currentText`,
   return:
   ```json
   { "conflict": true, "expected": "...", "actual": "..." }
   ```
   with status 409. Do not write.
4. If no conflict, call `updateCaseField()` to PATCH the cell.
5. Mark the rewrite as applied via `markRewriteApplied()`.
6. Return `{ applied: true, appliedAt }`.

### Task 7 — Env vars & deprecation

- Add to `.env.example`: `AIRTABLE_CASES_WRITE_TOKEN` (write-scoped on Cases
  base only).
- Update `README.md`'s setup section to document the new token and the new
  flow.
- Add a deprecation notice (a comment, not a runtime warning) to
  `app/api/analyse-case/route.ts` pointing users at `/api/feedback-triage` +
  `/api/draft-rewrites`. Do NOT delete `analyse-case` — leave it working for
  one release in case the new flow has issues.

## 4. Out of scope

Do not touch in this run:

- `/api/full-analysis` — separate flow, leave alone.
- `/api/triage-case` (guideline audit) — separate dashboard, leave alone.
- `/transcripts` — unrelated.
- Authentication — `middleware.ts` is fine as is.
- The OpenAI provider in `lib/ai-provider.ts` — keep it for the audit flow.

## 5. Constraints

- TypeScript strict mode must remain clean (`tsconfig.json` already strict).
- No new top-level dependencies unless absolutely necessary. Justify any
  addition in `package.json` with a comment.
- All new routes use `export const maxDuration = 300` (Vercel default cap).
- Every fetch from Airtable goes through `lib/airtable.ts` — no inline
  `fetch()` calls to `api.airtable.com` elsewhere.
- Opus calls in `/api/draft-rewrites` MUST honour the >80 cell guardrail.
- All errors surfaced to the UI must be human-readable strings, not stack
  traces. Follow the `readJsonResponse` pattern in `app/page.tsx` for
  HTML-vs-JSON handling.

## 6. Acceptance criteria (the goal validator checks these)

These are what the `/goal` Haiku validator will confirm before marking the
goal complete. Each is verifiable from the transcript — run the command and
let the output land in the conversation.

1. `npm run build` exits with code 0. Run it after all code changes are in.
2. `npx tsc --noEmit` exits with code 0.
3. The following NEW files exist and export the symbols named in this spec:
   - `app/api/feedback-triage/route.ts` (default POST handler)
   - `app/api/draft-rewrites/route.ts` (default POST handler)
   - `app/api/apply-edit/route.ts` (default POST handler)
   - `lib/feedback-analysis-store.ts` (`saveTriage`, `getTriage`,
     `saveRewrites`, `getRewrites`, `markRewriteApplied`)
4. The following EXISTING files have been modified:
   - `lib/airtable.ts` now exports `getCaseDataStructured`, `updateCaseField`,
     and `getCaseFieldValue`. The existing `getCaseData` is unchanged.
   - `lib/schemas.ts` exports `FEEDBACK_TRIAGE_SCHEMA` and
     `DRAFT_REWRITES_SCHEMA`.
   - `app/page.tsx` calls `/api/feedback-triage` (not `/api/analyse-case`)
     for the primary analyse button, and renders the new rewrite-table UI
     behind a "Generate rewrites" button.
   - `.env.example` mentions `AIRTABLE_CASES_WRITE_TOKEN`.
   - `README.md` documents the two-stage flow under a new section.
5. A `grep -r "analyse-case" app/` shows the route still exists but is no
   longer called by the UI's primary analyse flow.
6. The Opus-driven `/api/draft-rewrites` route uses model
   `claude-opus-4-7` (search the file for it). The
   `/api/feedback-triage` route uses model `claude-sonnet-4-6`.
7. `git status` is clean at the end (everything committed to a feature branch
   called `feat/two-stage-feedback-analysis`).

## 7. Definition of done — narrative version

A user opens `/`, picks a feedback submission, clicks **Check feedback**. The
new triage endpoint runs Sonnet against current guidelines, returns a verdict,
caches its findings, and shows the verdict + summary + email + a list of
flagged cells.

If the verdict says changes are needed, a **Generate rewrites** button appears
with a scope toggle. The user picks "Flagged only", clicks the button. Opus
re-fetches the case from Airtable, drafts per-cell replacements, returns them
to the UI as editable diff cards.

The user reviews each card, tweaks the suggested text inline on one of them,
then clicks **Update Airtable** on three of the five cards. Each click PATCHes
the right field on the right record in Airtable, with conflict detection. The
user sees ✓ Applied on those three cards and an unchanged status on the
remaining two. They return tomorrow, open the same feedback row, and the same
state is restored from the blob cache.

---

## 8. The `/goal` command to run

After saving this file at `docs/UPGRADE-PLAN.md` and committing it, in your
repo's terminal run `claude`, then paste:

```
/goal Implement the refactor specified in docs/UPGRADE-PLAN.md on a new
branch called feat/two-stage-feedback-analysis. The goal is met when ALL of
the following are true and visible in this conversation: (1) `npm run build`
output shows exit code 0; (2) `npx tsc --noEmit` output shows no errors; (3)
`ls app/api/feedback-triage/route.ts app/api/draft-rewrites/route.ts
app/api/apply-edit/route.ts lib/feedback-analysis-store.ts` returns all four
paths without error; (4) `grep -l "claude-opus-4-7"
app/api/draft-rewrites/route.ts` returns the path; (5) `grep -l
"claude-sonnet-4-6" app/api/feedback-triage/route.ts` returns the path; (6)
`grep "AIRTABLE_CASES_WRITE_TOKEN" .env.example` returns a match; (7) `git
status` shows a clean working tree on branch feat/two-stage-feedback-analysis;
(8) `git log --oneline -5` shows at least one commit on the new branch.
```

Notes on running it:

- Stay on a fast Sonnet/Opus pairing — `/goal` works best when the main agent
  has enough horsepower to make multi-file edits in one turn. Use
  `/model opus` before `/goal` for this task.
- Watch the first few turns. If the agent starts hallucinating Airtable APIs
  or skipping conflict detection, hit `Esc` and refine. Don't let it run for
  an hour unsupervised on its first attempt.
- If the validator says "goal met" but a manual smoke test fails (e.g. the UI
  doesn't render), re-run with a tightened condition that adds a manual smoke
  step — e.g. "`curl -X POST http://localhost:3000/api/feedback-triage -d
  ...` returns HTTP 200 with valid JSON". Be aware: the agent may not have
  your real env vars, so that test may need a mock layer or you'll need to
  pre-provision a `.env.local` for it.
- Cost guard: cap your Anthropic spend before kicking this off. A run of this
  size on Opus can spend $5-20 depending on how many wrong turns it takes.

## 9. After the goal completes

Manual verification you must still do (the validator can't):

1. Pull `.env.local` from Vercel (`vercel env pull .env.local`).
2. Create the new Cases-base write token at airtable.com/create/tokens and
   add it as `AIRTABLE_CASES_WRITE_TOKEN`.
3. `npm run dev`, walk through a real feedback submission end-to-end.
4. Confirm the Airtable record actually updates (look in the Airtable UI, not
   just the success toast).
5. Force a conflict (edit a cell in Airtable directly while a rewrite is
   pending) and confirm the 409 path shows the conflict UI.
6. Open a PR from `feat/two-stage-feedback-analysis` and let it sit overnight
   before merging — Opus-drafted Next.js routes have a known habit of putting
   API keys in client components.
