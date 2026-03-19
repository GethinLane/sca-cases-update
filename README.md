# ClawdBot — MRCGP SCA Case Review Dashboard

A Next.js dashboard that pulls user-submitted corrections from your Airtable feedback base, cross-references them against your case content, verifies them against UK clinical guidelines using Claude + web search, and presents field-by-field change recommendations plus a draft response email.

---

## Setup

### 1. Clone / download this project

### 2. Install dependencies
```bash
npm install
```

### 3. Create your Airtable token
- Go to https://airtable.com/create/tokens
- Create a token with these scopes:
  - `data.records:read`
  - `schema.bases:read`
- Add access to both your Cases base and your Feedback base

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
AIRTABLE_TOKEN=pat...
AIRTABLE_FEEDBACK_BASE_ID=app...
AIRTABLE_CASES_BASE_ID=app...
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
3. In Vercel project settings → Environment Variables, add the same three variables:
   - `AIRTABLE_TOKEN`
   - `AIRTABLE_FEEDBACK_BASE_ID`
   - `AIRTABLE_CASES_BASE_ID`
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
