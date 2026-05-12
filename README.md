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
You need two personal-access tokens at https://airtable.com/create/tokens:

**Read token (`AIRTABLE_TOKEN`)** — scopes: `data.records:read`, `schema.bases:read`. Grant access to all three bases: Cases, Feedback, and "Users ai" (Transcripts).

**Feedback write token (`AIRTABLE_FEEDBACK_WRITE_TOKEN`)** — scopes: `data.records:write`. Grant access to the Feedback base only. This is kept separate because the main read token is shared with other tools and intentionally read-only.

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
OPENAI_API_KEY=sk-...                 # Required for Transcript Insights (uses gpt-5.4-mini)
```

### 6. Run locally
```bash
npm run dev
```
Open http://localhost:3000

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
   - `OPENAI_API_KEY` (for Transcript Insights)
4. Deploy — done!

---

## How it works

1. Dashboard loads → calls `/api/fetch-feedback` → fetches all rows from your "User Feedback" table and joins each to its case data from the Cases base
2. You click "Analyse" on any submission → calls `/api/analyse-case` → Claude reads the full case content + the feedback, searches the web for relevant NICE/RCGP/BNF guidance, and returns:
   - A verdict (valid / invalid / partial / uncertain)
   - A plain-English summary
   - Field-by-field suggested changes with before/after text
   - A draft email response (if the submitter requested contact)
3. You review the suggestions and manually make any changes in Airtable

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
- `Frequency` — number (integer)
- `Clinically Relevant` — single select (`Yes` / `No`) or single line text
- `Relevance Reason` — long text
- `Suggested Addition` — long text
- `Example Quotes` — long text
- `Analysed Date` — date

**How it works:**
1. Pick a date → `/api/transcripts/fetch` pulls up to 300 rows from "Attempts" where `CreatedAt` is that day.
2. The client batches them 50 at a time and calls `/api/transcripts/analyse`, which sends each batch to `gpt-5.4-mini` with a strict JSON schema asking for: question, frequency, clinical relevance, suggested addition, example quotes.
3. Findings from all batches are merged client-side (deduped by case + normalised question).
4. Clinically relevant rows are pre-ticked; click "Save selected" to write to "Missing Case Details" via `/api/transcripts/save`.

**Optional env overrides:**
- `TRANSCRIPTS_OPENAI_MODEL` — default `gpt-5.4-mini`
- `OPENAI_TRANSCRIPTS_EFFORT` — default `medium` (set `low` for speed, `high` for tougher cases)
