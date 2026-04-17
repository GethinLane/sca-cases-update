// app/api/full-analysis/route.ts
// Deep review across EVERY field in the case.
// Always re-fetches from Airtable to guarantee fresh content (no stale cache).

import { NextRequest, NextResponse } from 'next/server'
import { getTriageResult } from '@/lib/triage-store'
import { getCaseData } from '@/lib/airtable'
import { callTriageAI } from '@/lib/ai-provider'
import { FULL_ANALYSIS_SCHEMA } from '@/lib/schemas'

export const maxDuration = 180

const FULL_ANALYSIS_SYSTEM_PROMPT = `You are a UK clinical guideline expert performing a COMPREHENSIVE review of an MRCGP SCA exam case.

You are given the COMPLETE case content — every field. Review EVERY field for clinical accuracy against current UK guidelines. Check:
1. Assessment/Diagnosis — differentials correct? outdated terms?
2. Management/Treatment — drug names, doses, step-up pathways, referral criteria?
3. History/Presenting complaint — matches the condition? missing red flags?
4. Marking criteria — competency descriptors align with current guidelines?
5. Explanation/Discussion — educational accuracy, current guidance referenced?
6. Safety netting/Follow-up — instructions and timelines correct?
7. Prescribing — interactions, contraindications, monitoring up to date?
8. Referral criteria — 2-week-wait, urgent thresholds current?

DO NOT rewrite entire fields. Only output the specific snippets that need to change.

FORMATTING RULES FOR suggestedText:
- Airtable rich text renders **bold**, *italic*, - bullets, 1. numbered lists.
- Airtable does NOT render #### as a heading — keep #### literal if the original uses it.
- suggestedText must be a DROP-IN REPLACEMENT for currentText — same formatting, corrected content.

CLINICAL RULES:
- Only suggest changes supported by current UK guidelines.
- Search MULTIPLE source types:
  1. NICE CKS (cks.nice.org.uk) — always first
  2. The relevant specialist society (MANDATORY — BAD/PCDS for derm, BTS for resp, ESC/BHF for cardio, RCOG/BMS/FSRH for women's health, RCPsych/BAP for mental health, BSG for gastro, BTA for thyroid, entuk.org for ENT, BAUS for urology, BASHH for sexual health, RCPCH for paeds, etc.)
  3. BNF (bnf.nice.org.uk) for any prescribing
- Be specific about what needs changing and why.
- If a field is correct, don't include it in fieldChanges.
- If the entire case is current, return an empty fieldChanges array with verdict "up-to-date".

Each fieldChange must have:
- fieldName: exact Airtable field name
- currentText: verbatim snippet from the case content (enough context to locate it)
- issue: what's wrong and why
- suggestedText: drop-in replacement, same formatting
- confidence: high/medium/low
- source: URL of the guideline supporting this change`

export async function POST(req: NextRequest) {
  try {
    const { caseNumber, extraContext } = await req.json()
    if (!caseNumber) return NextResponse.json({ error: 'Missing caseNumber' }, { status: 400 })

    // Always fetch FRESH from Airtable — Airtable is the source of truth.
    // Stale cached fields could make us suggest changes that have already been made.
    const caseData = await getCaseData(String(caseNumber))
    if (!caseData || !caseData.fields || Object.keys(caseData.fields).length === 0) {
      return NextResponse.json({ error: 'Case not found in Airtable or has no fields' }, { status: 404 })
    }

    const fieldEntries = Object.entries(caseData.fields)
    const allFieldsText = fieldEntries
      .map(([k, v]) => `### Field: ${k}\n${v}`)
      .join('\n\n---\n\n')
    const fieldNames = fieldEntries.map(([k]) => k).join(', ')

    // Triage context is optional — it's useful focus-pointing but not required.
    const triageResult = await getTriageResult(String(caseNumber))
    const triageContext = triageResult && triageResult.status !== 'pending'
      ? `PREVIOUS TRIAGE RESULT (for focus only — still review ALL fields):
Status: ${triageResult.status}
Summary: ${triageResult.summary}`
      : 'No previous triage data available — perform a full review of all fields.'

    const trimmedContext = extraContext ? String(extraContext).slice(0, 8000) : ''

    const userPrompt = `CASE ${caseNumber}

Fields present: ${fieldNames}

${triageContext}

---

COMPLETE CASE CONTENT (every field):

${allFieldsText}

---
${trimmedContext ? `
ADDITIONAL CONTEXT FROM REVIEWER:
${trimmedContext}

---
` : ''}
Review EVERY field for clinical accuracy against current UK guidelines. Search NICE CKS + relevant specialist society + BNF (if prescribing). Return specific before/after snippets for any text that needs correcting.`

    const maxSearches = parseInt(
      process.env.FULL_ANALYSIS_MAX_SEARCHES ?? process.env.TRIAGE_MAX_SEARCHES ?? '12',
    )
    const modelOverride = process.env.FULL_ANALYSIS_MODEL ?? 'claude-sonnet-4-6'
    const effort = process.env.OPENAI_FULL_ANALYSIS_EFFORT ?? process.env.OPENAI_REASONING_EFFORT ?? 'high'

    const aiResult = await callTriageAI(FULL_ANALYSIS_SYSTEM_PROMPT, userPrompt, {
      schema: FULL_ANALYSIS_SCHEMA,
      schemaName: 'submit_analysis',
      maxSearches,
      modelOverride,
      effortOverride: effort,
    })

    return NextResponse.json({
      ...aiResult.parsed,
      caseNumber: String(caseNumber),
      fieldNames,
      triageStatus: triageResult?.status ?? 'unknown',
      triageSummary: triageResult?.summary ?? '',
      citedUrls: aiResult.citedUrls,
      searchCount: aiResult.searchCount,
      provider: aiResult.provider,
      model: aiResult.model,
    })
  } catch (err: any) {
    console.error('Full analysis error:', err)
    return NextResponse.json({
      error: err.message ?? 'Unknown error',
      detail: err.cause?.message ?? err.stack?.slice(0, 500) ?? '',
    }, { status: 500 })
  }
}
