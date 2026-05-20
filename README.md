# ClawdBot — MRCGP SCA Case Review Dashboard

A Next.js dashboard that pulls user-submitted corrections from your Airtable feedback base, cross-references them against your case content, verifies them against UK clinical guidelines using Claude + web search, and presents field-by-field change recommendations plus a draft response email.

---

## Setup

### 1. Clone / download this project

### 2. Install dependencies
```bash
npm install
```

### 3. Create your Airtable tokens
You need three personal-access tokens at https://airtable.com/create/tokens:

**Read token (`AIRTABLE_TOKEN`)** — scopes: `data.records:read`, `schema.bases:read`. Grant access to all three bases: Cases, Feedback, and "Users ai" (Transcripts).

**Feedback write token (`AIRTABLE_FEEDBACK_WRITE_TOKEN`)** — scopes: `data.records:write`. Grant access to the Feedback base only. This is kept separate because the main read token is shared with other tools and intentionally read-only.

**Cases write token (`AIRTABLE_CASES_WRITE_TOKEN`)** — scopes: `data.records:write`. Grant access to the Cases base only. Used by the two-stage feedback flow's "Update Airtable" button when the reviewer accepts a per-cell rewrite suggestion. Kept narrowly scoped so a leak only exposes the Cases base.

### 4. Find your Base IDs
- Open your Airtable base in the browser
- The URL looks like: `https://airtable.com/appXXXXXXXX/tblYYYYYYYY/...`
- The part starting with `app` is your Base ID

### 5. Set environment variables
Copy `.env.example` to `.env.local`:
```bash
cp .env.example .env.local
```
Then edit `.env.local` and fill in:
```
AIRTABLE_TOKEN=pat...                 # Read-only token covering Cases, Feedback, and Users ai bases
AIRTABLE_FEEDBACK_BASE_ID=app...
AIRTABLE_CASES_BASE_ID=app...
AIRTABLE_TRANSCRIPTS_BASE_ID=app...   # "Users ai" base — only needed for Transcript Insights
AIRTABLE_FEEDBACK_WRITE_TOKEN=pat...  # Write-scoped token for the feedback base (used only when saving to "Missing Case Details")
AIRTABLE_CASES_WRITE_TOKEN=pat...     # Write-scoped token for the Cases base (used by /api/apply-edit)
ANTHROPIC_API_KEY=sk-ant-...          # Used by feedback triage (Sonnet) and draft rewrites (Opus)
OPENAI_API_KEY=sk-...                 # Required for Transcript Insights (uses gpt-5.4)
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...   # Vercel Blob — caches Stage 1 + Stage 2 results
AUTH_SECRET=...                       # Generate with: openssl rand -base64 32  (or: npx auth secret)
AUTH_GOOGLE_ID=...                    # Google OAuth client ID (see step 5b)
AUTH_GOOGLE_SECRET=...                # Google OAuth client secret
ALLOWED_EMAILS=alice@example.com,bob@example.com   # Comma-separated allowlist
```

### 5b. Configure Google OAuth (one-time setup)

The dashboard is protected by **Sign in with Google** + a per-email allowlist.
Two-factor authentication is whatever your Google account enforces — turn on
2-step verification at https://myaccount.google.com/security if it isn't
already.

1. Go to https://console.cloud.google.com/apis/credentials
2. Create a project (or pick an existing one).
3. Click **Create credentials → OAuth client ID → Web application**.
4. Set **Authorised redirect URIs** to:
   - `http://localhost:3000/api/auth/callback/google` (for local dev)
   - `https://<your-vercel-domain>/api/auth/callback/google` (for production —
     add this after your first Vercel deploy when you know the domain)
5. Copy the **Client ID** into `AUTH_GOOGLE_ID` and **Client secret** into
   `AUTH_GOOGLE_SECRET`.
6. Fill `ALLOWED_EMAILS` with every Google email permitted to sign in
   (comma-separated, case-insensitive). Anyone signing in with an email NOT
   on this list is rejected even if Google authenticates them successfully.
7. Generate `AUTH_SECRET` once with `openssl rand -base64 32` (or
   `npx auth secret`). Use the **same** value in local dev and production —
   changing it invalidates all sessions.

### 6. Run locally
```bash
npm run dev
```
Open http://localhost:3000 — you'll be redirected to `/login` and prompted
to sign in with Google.

---

## Deploying to Vercel

1. Push this project to a GitHub repo
2. Go to https://vercel.com and import the repo
3. In Vercel project settings → Environment Variables, add the same variables:
   - `AIRTABLE_TOKEN` (read scope, covers all three bases)
   - `AIRTABLE_FEEDBACK_BASE_ID`
   - `AIRTABLE_CASES_BASE_ID`
   - `AIRTABLE_TRANSCRIPTS_BASE_ID` (for Transcript Insights)
   - `AIRTABLE_FEEDBACK_WRITE_TOKEN` (separate write-scoped token for the feedback base — required to save Missing Case Details)
   - `AIRTABLE_CASES_WRITE_TOKEN` (write-scoped token for the Cases base — required for the per-cell Apply Airtable updates)
   - `ANTHROPIC_API_KEY` (for triage + draft-rewrite endpoints)
   - `OPENAI_API_KEY` (for Transcript Insights)
   - `BLOB_READ_WRITE_TOKEN` (Vercel Blob — caches Stage 1 and Stage 2 results)
   - `AUTH_SECRET` (session-signing secret — same value as local)
   - `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` (Google OAuth client)
   - `ALLOWED_EMAILS` (comma-separated allowlist of permitted Google accounts)
4. After the first deploy, copy the Vercel domain and add
   `https://<that-domain>/api/auth/callback/google` to the Google OAuth
   client's Authorised redirect URIs. Redeploy if needed.
5. Done — visit the site and sign in with an allowlisted Google account.

### Removing a user's access

Delete their email from `ALLOWED_EMAILS` in Vercel env vars and redeploy.
To force-revoke active sessions immediately, also rotate `AUTH_SECRET` —
this invalidates every existing session, so everyone signs in again.

---

## How it works — the two-stage feedback flow

1. **Dashboard loads** → calls `/api/fetch-feedback` → fetches all rows from your "User Feedback" table and joins each to its case data from the Cases base.
2. **Stage 1 — Triage** (button: *Check feedback*) → calls `/api/feedback-triage` → Sonnet 4.6 reads the full case (preserving Airtable record identity), verifies the feedback against current UK guidelines via web search, and returns:
   - A verdict (valid / invalid / partial / uncertain)
   - A plain-English summary
   - A list of **flagged cells** — `(recordId, fieldName)` pairs that need review
   - A draft email response (if the submitter requested contact)

   The triage is cached to Vercel Blob keyed by feedback ID, along with a snapshot of the case content Stage 1 reasoned over.
3. **Stage 2 — Rewrites** (button: *Generate rewrites*, scope toggle: *Flagged only* / *Whole case*) → calls `/api/draft-rewrites` → Opus 4.7 re-fetches fresh case data from Airtable, then drafts a drop-in replacement for each target cell. Returns per-cell:
   - `currentText` (verbatim, used for conflict detection)
   - `suggestedText` (the new value, copy-paste-ready)
   - `rationale`, `confidence`, optional `sourceUrl`
4. **Stage 3 — Apply** (button: *Update Airtable* per card) → calls `/api/apply-edit` → before writing, the endpoint re-fetches the live Airtable value. If it has changed since Stage 2, the write is refused with HTTP 409 and the live value is surfaced to the UI so the reviewer can decide what to do. Otherwise the single field on the single Airtable record is PATCHed via `AIRTABLE_CASES_WRITE_TOKEN`.

The reviewer can edit any `suggestedText` inline in the textarea before clicking Update Airtable. Applied rewrites are persisted with a timestamp so reopening the same feedback restores state.

The previous one-shot endpoint `/api/analyse-case` is deprecated but left in place for one release as a fallback.

---

## Airtable structure expected

**Feedback base — table named "User Feedback":**
- `Case` — number (links to case number)
- `Issue Summary` — long text
- `Contact regarding outcome` — checkbox or Yes/No
- `Contact Email` — email

**Cases base — one table per case, named "Case 1", "Case 2", etc.**
Each table can have multiple rows; all rows are merged into a single field map for analysis.

---

## Transcript Insights (`/transcripts`)

Scans a day of bot conversations for recurring patient questions where the bot hedged or said it didn't know, then judges clinical relevance and suggests case content to add.

**Source — Users ai base, "Attempts" table:**
- `CaseID` — string/number, the case the candidate practised
- `Transcript` — long text, the full bot/candidate conversation
- `CreatedAt` — date or datetime, used to filter by day

**Output — Feedback base, "Missing Case Details" table (create this manually with these exact column names):**
- `CaseID` — single line text
- `Question` — long text
- `Frequency` — number (integer) — times this question was asked & deflected *within this case* (not across all cases)
- `Clinically Relevant` — single select (`Yes` / `No`) or single line text
- `Relevance Reason` — long text
- `Suggested Addition` — long text
- `Example Quotes` — long text — verbatim candidate (user) quotes
- `Bot Response` — long text — verbatim bot deflection wording
- `Analysed Date` — date

**How it works:**
1. Pick a date → `/api/transcripts/fetch` pulls up to 300 rows from "Attempts" where `CreatedAt` is that day.
2. The client batches them 50 at a time and calls `/api/transcripts/analyse`, which sends each batch to `gpt-5.4` with a strict JSON schema asking for: question, frequency, clinical relevance, suggested addition, example quotes.
3. Findings from all batches are merged client-side (deduped by case + normalised question).
4. Clinically relevant rows are pre-ticked; click "Save selected" to write to "Missing Case Details" via `/api/transcripts/save`.

**Optional env overrides:**
- `TRANSCRIPTS_OPENAI_MODEL` — default `gpt-5.4`
- `OPENAI_TRANSCRIPTS_EFFORT` — default `medium` (set `low` for speed, `high` for tougher cases)

---

## Case Uploader (`/upload-case`)

Drops in a `.md` or `.docx` SCA case and writes it to an existing "Case N"
table in the Cases base. Each `## Heading` becomes an Airtable field; lists
under that heading become row 1, row 2, … up to 8 rows.

**How it works:**
1. Upload a `.md` (numbered-list style) or `.docx` (Heading 2 + paragraph
   style). `.docx` is converted to markdown server-side with
   [`mammoth`](https://www.npmjs.com/package/mammoth).
2. `lib/case-parser.ts` splits on `##` headings. Bodies of fields known to
   be multi-row (Past Medical History, Notes Entry Label/Content, Positive
   / Negative Indicators, Key Issues, Reference Labels/URLs, …) are split
   into ordered items — item N becomes row N. Source order is preserved
   strictly: the top three Positive Indicators carry more weighting and
   MUST land in rows 1-3.
3. `## ICE: Ideas` / `Concerns` / `Expectations` are special-cased: they
   all write to the `ICE` field, into rows 1, 2 and 3 respectively.
4. The target-table dropdown is populated via the Airtable Metadata API
   (`schema.bases:read`, already on `AIRTABLE_TOKEN`). Real field names on
   the chosen table become the source of truth — anything the parser
   couldn't auto-match is surfaced as "Unmapped" and you map it via a
   dropdown.
5. Per-item textareas let you tweak before writing. "Upload section"
   writes one section at a time (handy for fixing a single mis-mapped
   field); "Upload all" creates the full set of rows in one batch.

**Requires:**
- An existing "Case N" table in the Cases base. The uploader does **not**
  create tables — pre-create the empty table in Airtable first. (Adding
  `schema.bases:write` to `AIRTABLE_CASES_WRITE_TOKEN` would let us
  auto-create, but the current write token is intentionally narrower.)
- `AIRTABLE_CASES_WRITE_TOKEN` (already required for the per-cell feedback
  apply flow).
