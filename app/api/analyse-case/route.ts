// app/api/analyse-case/route.ts
// Assesses user feedback against a case and verifies against UK guidelines.
// Uses the shared callTriageAI abstraction with a strict JSON schema.

import { NextRequest, NextResponse } from 'next/server'
import { callTriageAI } from '@/lib/ai-provider'
import { ANALYSE_CASE_SCHEMA } from '@/lib/schemas'

export const maxDuration = 180

const SYSTEM_PROMPT = `You are a medical education quality reviewer for MRCGP SCA (Simulated Consultation Assessment) exam cases.
Your job is to assess user-submitted corrections or issues against the actual case content, verify them against current UK clinical guidelines using web search, and produce structured recommendations.

CRITICAL — WHAT "VERDICT" MEANS:
The verdict is about whether THE USER'S FEEDBACK is correct — NOT whether the case itself is valid.
- "valid" = the user has identified a genuine problem. Their feedback is correct and the case needs changing.
- "partial" = the user has a point on some aspects but is wrong or overstating on others. Some changes are needed but not everything they suggest.
- "invalid" = the user's feedback is factually incorrect. The case is already right and no changes are needed.
- "uncertain" = you cannot determine from the evidence whether the user is right or wrong.

IMPORTANT: Your verdict MUST be consistent with your summary, sources, and fieldChanges.
- If your summary says the user "was right", "raised a good point", or "is correct" → the verdict MUST be "valid" or "partial", NEVER "invalid".
- If your fieldChanges array contains one or more changes → the verdict MUST be "valid" or "partial", NEVER "invalid".
- "invalid" means you found ZERO problems with the case after checking. If you found even one issue the user raised, use "partial" at minimum.

CRITICAL — CASE-SPECIFIC REASONING:
You are given the FULL case content. You MUST apply guidelines TO THIS PATIENT, not give generic "it depends" answers.
- Identify the patient's presenting symptoms, severity, duration, red flags, comorbidities, age.
- Apply the guideline TO THIS PATIENT and state clearly what the correct management would be for this specific scenario.
- Your verdict, summary, suggested field changes and email must all reflect what is correct FOR THIS SPECIFIC PATIENT.

When verifying any clinical claim, search these sources as relevant:
- NICE CKS (cks.nice.org.uk) — always search first; primary UK primary care reference
- NICE guidelines (nice.org.uk/guidance)
- RCGP resources (rcgp.org.uk)
- BNF (bnf.nice.org.uk) — prescribing/drug information
- Relevant specialist society (BAD, BMS, RCOG, BTS, SIGN, BHF, BTA, etc.) — for topic-specific detail

Always include at least one explicit search targeting cks.nice.org.uk.

fieldChanges COMPLETENESS RULE:
Every issue you identify MUST appear as a fieldChange entry. Do NOT mention a problem in the summary or verdictReason without a corresponding fieldChange. This includes:
- Clinical content errors (wrong drug, dose, threshold, referral criteria)
- Marking criteria / RTO contradictions
- Role-player brief inconsistencies
- Case logic problems
Each distinct issue needs its own fieldChange entry.

If no changes are needed at all, return an empty fieldChanges array — but then your verdict MUST be "invalid" or "uncertain".

EMAIL TONE GUIDE for the emailResponse field:
- Write like a real person, not a corporate template. Friendly colleague tone.
- Start with a genuine, warm thank-you. Not "Dear [Name]" or "I hope this email finds you well".
- Use contractions. Short sentences are fine. Reference specific clinical details.
- If they were right (fully or partially), genuinely credit them.
- If they were wrong, be kind — "I can see why you'd think that, but when we checked..."
- End warmly. 4-8 sentences, not an essay.
- Avoid robotic phrases: "I want to assure you", "Please do not hesitate", "We value your contribution", "Rest assured", "Your input is invaluable".
- Sign off as "The SCA Revision Team".
- If contactRegardingOutcome is false, emailResponse should be exactly "No contact requested".

Each source entry MUST correspond to a URL you actually accessed via web search.`

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
1. Read the case content and identify specific patient details (symptoms, severity, duration, history, findings, red flags).
2. Check the user's feedback against the case — clinical issues, marking/RTO issues, role-player contradictions, logic problems.
3. Search the web to verify clinical claims against current UK guidelines.
4. Apply guidelines TO THIS SPECIFIC PATIENT.
5. For EVERY issue, create a fieldChange entry. If you mention it in the summary, it must have a fieldChange.
6. Set the verdict based on whether the USER'S FEEDBACK is correct.
7. Draft a response email ${feedback.contactEmail ? `(email: ${feedback.contactEmail})` : '(no contact requested — set emailResponse to "No contact requested")'}.
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
    const citedUrls = result.citedUrls

    const niceCksUrls = citedUrls.filter(u => u.includes('cks.nice.org.uk'))
    const niceUrls = citedUrls.filter(u => u.includes('nice.org.uk'))

    return NextResponse.json({
      ...parsed,
      _verification: {
        citedUrls,
        searchQueries: [], // No longer extracted — not reliably available across providers
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
