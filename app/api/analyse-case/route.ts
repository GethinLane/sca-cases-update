// app/api/analyse-case/route.ts
// Assesses user feedback against a case and verifies against UK guidelines.
// Uses callTriageAI with a strict JSON schema that forces a self-consistency check
// before the verdict is written, so contradictions (invalid verdict + fieldChanges)
// become structurally impossible rather than something we have to silently override.

import { NextRequest, NextResponse } from 'next/server'
import { callTriageAI } from '@/lib/ai-provider'
import { ANALYSE_CASE_SCHEMA } from '@/lib/schemas'

export const maxDuration = 180

const SYSTEM_PROMPT = `You are a medical education quality reviewer for MRCGP SCA (Simulated Consultation Assessment) exam cases.
Your job is to assess user-submitted corrections or issues against the actual case content, verify them against current UK clinical guidelines using web search, and produce structured recommendations.

═══════════════════════════════════════════════════════════════════════
OUTPUT ORDER — STRICTLY FOLLOW THIS SEQUENCE
═══════════════════════════════════════════════════════════════════════
Fill the JSON fields in this logical order. The verdict is DERIVED from the fields above it — do NOT decide the verdict first.

  1. caseScenario      → describe the patient
  2. summary           → explain what you found
  3. sources           → list the URLs you checked
  4. fieldChanges      → list every issue that needs fixing
  5. verdictSelfCheck  → mechanical check: count fieldChanges, flag summary language, pick rule
  6. verdict           → MUST follow from verdictSelfCheck.verdictRule
  7. verdictReason     → explain in plain English
  8. emailResponse     → draft reply (or "No contact requested")

═══════════════════════════════════════════════════════════════════════
WHAT "VERDICT" MEANS
═══════════════════════════════════════════════════════════════════════
The verdict is about whether THE USER'S FEEDBACK is correct — NOT whether the case itself is valid.
- "valid"     = user identified a genuine problem. Case needs changing.
- "partial"   = user has a point on some aspects but is wrong on others. Some changes needed.
- "invalid"   = user's feedback is factually incorrect. Case is already right. NO changes needed.
- "uncertain" = cannot determine whether the user is right or wrong.

═══════════════════════════════════════════════════════════════════════
THE VERDICT CONSISTENCY RULE (CANNOT BE BROKEN)
═══════════════════════════════════════════════════════════════════════
After writing fieldChanges and summary, compute verdictSelfCheck HONESTLY:

  IF fieldChangesCount > 0 OR summaryAcknowledgesProblem = true:
      → verdictRule MUST be "changes_needed_partial_or_valid"
      → verdict MUST be "valid" or "partial" — NEVER "invalid"

  IF fieldChangesCount = 0 AND summaryAcknowledgesProblem = false:
      → verdictRule is one of:
         • "no_changes_feedback_was_wrong_so_invalid" → verdict = "invalid"
         • "no_changes_cannot_determine_so_uncertain" → verdict = "uncertain"

Phrases in summary that count as acknowledging a problem:
"the user is correct", "good point", "valid point", "should be updated", "is reasonable",
"has identified a legitimate issue", "needs changing", "is outdated".

If you find yourself writing "invalid" while fieldChanges has entries, STOP. Re-read the rule. The two MUST agree.

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
fieldChanges COMPLETENESS
═══════════════════════════════════════════════════════════════════════
Every issue must appear as a fieldChange entry:
- Clinical content errors (drug, dose, threshold, referral criteria)
- Marking criteria / RTO contradictions
- Role-player brief inconsistencies
- Case logic problems

Each distinct issue gets its own entry. Don't lump multiple issues into one.

CRITICAL FOR suggestedText (copy/paste requirement):
- suggestedText MUST be the exact final replacement text the editor can paste directly into the case field.
- Do NOT write meta-instructions (e.g. "A condensed version...", "covering:", "remove...", "rewrite to...").
- Do NOT describe what to change. Perform the change and provide the finished prose.
- Write in normal case-authoring style (complete sentences/paragraphs), not bullet instructions unless the case field itself is a bullet list.
- If updating part of a paragraph, still provide a coherent replacement passage ready to paste.
- Never leave truncated/incomplete endings.

═══════════════════════════════════════════════════════════════════════
EMAIL TONE
═══════════════════════════════════════════════════════════════════════
- Warm, friendly colleague tone. No corporate-speak.
- Start with a genuine thank-you. Not "Dear [Name]" or "I hope this finds you well".
- Contractions. Reference specific clinical details.
- If they were right, credit them. If wrong, be kind — "I can see why you'd think that, but when we checked..."
- 4-8 sentences. Sign off as "The SCA Revision Team".
- Avoid: "I want to assure you", "Please do not hesitate", "We value your contribution", "Rest assured", "Your input is invaluable".
- If no contact was requested, emailResponse must be exactly: "No contact requested".

Each source entry must correspond to a URL you accessed via web search.`

export async function POST(req: NextRequest) {
  const { feedback, caseData, extraContext } = await req.json()

  if (!feedback || !caseData) {
    return NextResponse.json({ error: 'Missing feedback or caseData' }, { status: 400 })
  }

  const caseFieldsText = Object.entries(caseData.fields as Record<string, string>)
    .map(([k, v]) => `### Field: ${k}\n${v}`)
    .join('\n\n---\n\n')
    .slice(0, 30000)

  const userPrompt = `CASE NUMBER: ${caseData.caseNumber}

FULL CASE CONTENT:
${caseFieldsText}

---

USER FEEDBACK / ISSUE SUBMITTED:
${feedback.issueSummary}

---

Steps:
1. Read the case content and identify patient details (symptoms, severity, duration, history, findings, red flags).
2. Check the user's feedback against the case — clinical, marking/RTO, role-player, logic.
3. Search the web to verify clinical claims against current UK guidelines.
4. Apply guidelines TO THIS SPECIFIC PATIENT.
5. For EVERY issue, create a fieldChange entry.
6. Fill verdictSelfCheck HONESTLY by counting your fieldChanges and reading your own summary.
7. Let verdict follow from verdictSelfCheck.verdictRule — do not override it.
8. Draft a response email ${feedback.contactEmail ? `(email: ${feedback.contactEmail})` : '(no contact requested — set emailResponse to "No contact requested")'}.
${extraContext ? `
---

ADDITIONAL CONTEXT FROM REVIEWER:
${extraContext}` : ''}`

  try {
    const maxSearches = parseInt(process.env.ANALYSE_MAX_SEARCHES ?? '6')
    const effort = process.env.OPENAI_ANALYSE_EFFORT ?? process.env.OPENAI_REASONING_EFFORT ?? 'medium'
    const modelOverride = process.env.ANALYSE_MODEL

    const result = await callTriageAI(SYSTEM_PROMPT, userPrompt, {
      schema: ANALYSE_CASE_SCHEMA,
      schemaName: 'submit_analysis',
      maxSearches,
      modelOverride,
      effortOverride: effort,
    })

    const parsed = result.parsed

    // ── Final sanity check on the schema's own self-check ──
    // Schema-level enforcement catches most contradictions, but we still surface
    // the very rare mismatches loudly rather than silently rewriting (old behaviour).
    const hasFieldChanges = Array.isArray(parsed.fieldChanges) && parsed.fieldChanges.length > 0
    if (hasFieldChanges && parsed.verdict === 'invalid') {
      return NextResponse.json({
        error:
          'Model returned a self-contradicting result: verdict is "invalid" but fieldChanges is non-empty. ' +
          'This should have been caught by verdictSelfCheck. Please re-run the analysis. ' +
          'If this keeps happening, increase OPENAI_ANALYSE_EFFORT to "high" or switch to a stronger model.',
        _debug: {
          verdict: parsed.verdict,
          verdictSelfCheck: parsed.verdictSelfCheck,
          fieldChangesCount: parsed.fieldChanges.length,
          provider: result.provider,
          model: result.model,
        },
      }, { status: 422 })
    }

    const citedUrls = result.citedUrls
    const niceCksUrls = citedUrls.filter(u => u.includes('cks.nice.org.uk'))
    const niceUrls = citedUrls.filter(u => u.includes('nice.org.uk'))

    return NextResponse.json({
      ...parsed,
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
    console.error('analyse-case error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
