// app/api/feedback-triage/route.ts
// Stage 1 of the two-stage feedback flow.
// Sonnet 4.6 verifies the feedback against current UK guidelines, identifies which
// (recordId, fieldName) cells are clinically affected, and drafts a response email.
// It does NOT draft replacement text — that's Stage 2's job.

import { NextRequest, NextResponse } from 'next/server'
import { callTriageAI } from '@/lib/ai-provider'
import { FEEDBACK_TRIAGE_SCHEMA } from '@/lib/schemas'
import {
  getCaseDataStructured,
  getFeedbackById,
} from '@/lib/airtable'
import {
  saveTriage,
  getTriage,
  type FeedbackTriageRecord,
  type FeedbackTriageResult,
} from '@/lib/feedback-analysis-store'

export const maxDuration = 300

// STAGE1_PROVIDER — see UPGRADE-PLAN.md decision A. Anthropic Sonnet 4.6 chosen
// for native allowed_domains web-search restricted to lib/guideline-domains.ts.
const STAGE1_PROVIDER = 'anthropic' as const
const STAGE1_MODEL = 'claude-sonnet-4-6'

const SYSTEM_PROMPT = `You are a medical education quality reviewer for MRCGP SCA (Simulated Consultation Assessment) exam cases.
You are running STAGE 1 of a two-stage feedback review process.

Stage 1 (you):
  - Read the user's feedback and the full case content.
  - Search the web to verify clinical claims against current UK guidelines.
  - Identify WHICH cells in the case (by recordId + fieldName) are clinically affected.
  - DO NOT draft replacement text. Stage 2 (a separate model) handles the rewriting.
  - Draft the reply email if the submitter asked to be contacted.

═══════════════════════════════════════════════════════════════════════
OUTPUT ORDER — STRICTLY FOLLOW THIS SEQUENCE
═══════════════════════════════════════════════════════════════════════
Fill the JSON fields in this logical order. The verdict is DERIVED from the fields above it — do NOT decide the verdict first.

  1. caseScenario      → describe the patient
  2. summary           → explain what you found
  3. sources           → list the URLs you checked
  4. flaggedCells      → list every cell that needs to be reviewed/changed
  5. verdictSelfCheck  → mechanical check: count flaggedCells, flag summary language, pick rule
  6. verdict           → MUST follow from verdictSelfCheck.verdictRule
  7. verdictReason     → explain in plain English
  8. emailSubject      → subject line for the reply (or "No contact requested")
  9. emailResponse     → draft reply body (or "No contact requested")

═══════════════════════════════════════════════════════════════════════
WHAT "VERDICT" MEANS
═══════════════════════════════════════════════════════════════════════
The verdict is about whether THE USER'S FEEDBACK is correct — NOT whether the case itself is valid.
- "valid"     = user identified a genuine problem. Cells need changing.
- "partial"   = user has a point on some aspects but is wrong on others. Some cells need changing.
- "invalid"   = user's feedback is factually incorrect. Case is already right. NO cells flagged.
- "uncertain" = cannot determine whether the user is right or wrong.

═══════════════════════════════════════════════════════════════════════
THE VERDICT CONSISTENCY RULE (CANNOT BE BROKEN)
═══════════════════════════════════════════════════════════════════════
After writing flaggedCells and summary, compute verdictSelfCheck HONESTLY:

  IF flaggedCellsCount > 0 OR summaryAcknowledgesProblem = true:
      → verdictRule MUST be "changes_needed_partial_or_valid"
      → verdict MUST be "valid" or "partial" — NEVER "invalid"

  IF flaggedCellsCount = 0 AND summaryAcknowledgesProblem = false:
      → verdictRule is one of:
         • "no_changes_feedback_was_wrong_so_invalid" → verdict = "invalid"
         • "no_changes_cannot_determine_so_uncertain" → verdict = "uncertain"

═══════════════════════════════════════════════════════════════════════
FLAGGED CELLS — HOW TO PICK THEM
═══════════════════════════════════════════════════════════════════════
The case is given to you as a list of RECORDS. Each record has:
  - recordId   (Airtable record ID like "recABC...")
  - rowIndex   (0-based position)
  - fields     (map of field name → value)

For every clinical issue the feedback raises:
- Find the SPECIFIC record(s) and field(s) that contain the affected text.
- Add one flaggedCells entry per affected (recordId, fieldName) pair.
- DO NOT invent recordIds. Copy them verbatim from the data given to you.
- DO NOT lump multiple issues into one entry — one entry per cell.
- Describe the problem in "issue". Do NOT propose a fix.

═══════════════════════════════════════════════════════════════════════
CASE-SPECIFIC REASONING
═══════════════════════════════════════════════════════════════════════
Apply guidelines TO THIS PATIENT, not generically:
- Identify symptom severity, duration, red flags, comorbidities, age.
- State the correct management FOR THIS SPECIFIC SCENARIO.
- Don't hedge with "it depends" — use case details to make a concrete judgement.

═══════════════════════════════════════════════════════════════════════
SEARCH SOURCES
═══════════════════════════════════════════════════════════════════════
- NICE CKS (cks.nice.org.uk) — always search first
- NICE guidelines (nice.org.uk/guidance)
- RCGP (rcgp.org.uk)
- BNF (bnf.nice.org.uk)
- Relevant specialist society (BAD, BMS, RCOG, BTS, SIGN, BHF, BTA, BASHH, FSRH, RCPsych, BSG, entuk.org, BAUS, RCPCH etc.)

Always include at least one search of cks.nice.org.uk.

═══════════════════════════════════════════════════════════════════════
EMAIL TONE
═══════════════════════════════════════════════════════════════════════
- Warm, friendly colleague tone. No corporate-speak.
- Start with a genuine thank-you. Not "Dear [Name]" or "I hope this finds you well".
- Contractions. Reference specific clinical details.
- If they were right, credit them. If wrong, be kind — "I can see why you'd think that, but when we checked..."
- 4-8 sentences. Sign off as "The SCA Revision Team".
- Avoid: "I want to assure you", "Please do not hesitate", "We value your contribution", "Rest assured", "Your input is invaluable".

═══════════════════════════════════════════════════════════════════════
EMAIL SUBJECT
═══════════════════════════════════════════════════════════════════════
- Format: "Re: Case <N> feedback — <short clinical topic>".
  e.g. "Re: Case 14 feedback — atrial fibrillation management"
       "Re: Case 7 feedback — childhood asthma stepwise treatment"
- Keep it under ~80 characters.
- No emoji, no exclamation marks, no all-caps.

If no contact was requested, set BOTH emailSubject and emailResponse to exactly: "No contact requested".`

interface RequestBody {
  feedbackId?: string
  extraContext?: string
}

export async function POST(req: NextRequest) {
  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const feedbackId = body.feedbackId
  if (!feedbackId) {
    return NextResponse.json({ error: 'Missing feedbackId' }, { status: 400 })
  }

  try {
    const feedback = await getFeedbackById(feedbackId)
    if (!feedback) {
      return NextResponse.json({ error: `Feedback ${feedbackId} not found in Airtable.` }, { status: 404 })
    }
    if (!feedback.caseNumber) {
      return NextResponse.json(
        { error: 'Feedback row has no Case number — cannot look up case data.' },
        { status: 400 },
      )
    }

    const caseData = await getCaseDataStructured(feedback.caseNumber)
    if (!caseData || caseData.records.length === 0) {
      return NextResponse.json(
        { error: `Case ${feedback.caseNumber} not found in Airtable or has no records.` },
        { status: 404 },
      )
    }

    const caseText = caseData.records
      .map(rec => {
        const fieldsText = Object.entries(rec.fields)
          .map(([k, v]) => `  Field "${k}":\n${indent(v, 4)}`)
          .join('\n\n')
        return `RECORD (recordId="${rec.recordId}", rowIndex=${rec.rowIndex}):\n${fieldsText}`
      })
      .join('\n\n---\n\n')
      .slice(0, 60000)

    const userPrompt = `CASE NUMBER: ${caseData.caseNumber} (table "${caseData.tableName}")

STRUCTURED CASE CONTENT (one block per Airtable record):

${caseText}

---

USER FEEDBACK / ISSUE SUBMITTED:
${feedback.issueSummary}

---

Steps:
1. Read every record and identify patient details (symptoms, severity, duration, history, findings, red flags).
2. Check the user's feedback against the case — clinical, marking/RTO, role-player, logic.
3. Search the web to verify clinical claims against current UK guidelines.
4. Apply guidelines TO THIS SPECIFIC PATIENT.
5. For EVERY affected cell, create a flaggedCells entry with the verbatim recordId, fieldName, and rowIndex.
6. Fill verdictSelfCheck HONESTLY by counting your flaggedCells and reading your own summary.
7. Let verdict follow from verdictSelfCheck.verdictRule — do not override it.
8. Draft a response email ${feedback.contactRegardingOutcome
        ? `(contact requested${feedback.contactEmail ? `, email: ${feedback.contactEmail}` : ''})`
        : '(no contact requested — set emailResponse to "No contact requested")'}.
${body.extraContext ? `
---

ADDITIONAL CONTEXT FROM REVIEWER:
${body.extraContext.slice(0, 8000)}` : ''}`

    const maxSearches = parseInt(process.env.FEEDBACK_TRIAGE_MAX_SEARCHES ?? '6')

    const result = await callTriageAI(SYSTEM_PROMPT, userPrompt, {
      schema: FEEDBACK_TRIAGE_SCHEMA,
      schemaName: 'submit_triage',
      maxSearches,
      modelOverride: STAGE1_MODEL,
      providerOverride: STAGE1_PROVIDER,
    })

    const parsed = result.parsed as FeedbackTriageResult

    // ── Sanity check: schema enforces this but surface late mismatches anyway ──
    const hasFlagged = Array.isArray(parsed.flaggedCells) && parsed.flaggedCells.length > 0
    if (hasFlagged && parsed.verdict === 'invalid') {
      return NextResponse.json(
        {
          error:
            'Model returned a self-contradicting result: verdict is "invalid" but flaggedCells is non-empty. Please re-run.',
          _debug: {
            verdict: parsed.verdict,
            verdictSelfCheck: parsed.verdictSelfCheck,
            flaggedCellsCount: parsed.flaggedCells.length,
            provider: result.provider,
            model: result.model,
          },
        },
        { status: 422 },
      )
    }

    // ── Drop flagged cells that reference unknown records/fields ──
    const validRecordIds = new Set(caseData.records.map(r => r.recordId))
    const fieldsByRecord = new Map(
      caseData.records.map(r => [r.recordId, new Set(Object.keys(r.fields))]),
    )
    const cleanFlagged = (parsed.flaggedCells ?? []).filter(fc => {
      if (!validRecordIds.has(fc.recordId)) return false
      const fields = fieldsByRecord.get(fc.recordId)
      return fields ? fields.has(fc.fieldName) : false
    })

    const cleanedTriage: FeedbackTriageResult = {
      ...parsed,
      flaggedCells: cleanFlagged,
    }

    const record: FeedbackTriageRecord = {
      feedbackId,
      caseNumber: feedback.caseNumber,
      triagedAt: new Date().toISOString(),
      triage: cleanedTriage,
      caseSnapshot: caseData,
      citedUrls: result.citedUrls,
      provider: result.provider,
      model: result.model,
      searchCount: result.searchCount,
    }
    await saveTriage(record)

    const citedUrls = result.citedUrls
    const niceCksUrls = citedUrls.filter(u => u.includes('cks.nice.org.uk'))
    const niceUrls = citedUrls.filter(u => u.includes('nice.org.uk'))

    return NextResponse.json({
      ...cleanedTriage,
      feedbackId,
      caseNumber: feedback.caseNumber,
      triagedAt: record.triagedAt,
      _verification: {
        citedUrls,
        searchQueries: [],
        niceCksVerified: niceCksUrls.length > 0,
        niceVerified: niceUrls.length > 0,
        niceCksUrls,
        niceUrls,
      },
      _meta: {
        provider: result.provider,
        model: result.model,
        searchCount: result.searchCount,
      },
    })
  } catch (err: any) {
    console.error('feedback-triage error:', err?.message ?? err)
    return NextResponse.json({ error: err?.message ?? 'Unknown error' }, { status: 500 })
  }
}

// Re-run triage support: GET returns the cached result if any.
export async function GET(req: NextRequest) {
  const feedbackId = req.nextUrl.searchParams.get('feedbackId')
  if (!feedbackId) {
    return NextResponse.json({ error: 'Missing feedbackId' }, { status: 400 })
  }
  const cached = await getTriage(feedbackId)
  if (!cached) {
    return NextResponse.json({ cached: false }, { status: 404 })
  }
  return NextResponse.json({ cached: true, ...cached.triage, _meta: {
    provider: cached.provider,
    model: cached.model,
    searchCount: cached.searchCount,
    triagedAt: cached.triagedAt,
  }, _verification: {
    citedUrls: cached.citedUrls,
    searchQueries: [],
    niceCksVerified: cached.citedUrls.some(u => u.includes('cks.nice.org.uk')),
    niceVerified: cached.citedUrls.some(u => u.includes('nice.org.uk')),
    niceCksUrls: cached.citedUrls.filter(u => u.includes('cks.nice.org.uk')),
    niceUrls: cached.citedUrls.filter(u => u.includes('nice.org.uk')),
  }})
}

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n)
  return s.split('\n').map(line => pad + line).join('\n')
}
