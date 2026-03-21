// app/api/full-analysis/route.ts
// Takes a case number, loads its triage result (with stored case data),
// and runs a deep analysis across EVERY field in the case — Assessment,
// Management, History, Marking Criteria, Explanation, etc.
// Returns field-by-field change suggestions (currentText → suggestedText).

import { NextRequest, NextResponse } from 'next/server'
import { getTriageResult } from '@/lib/triage-store'
import { getCaseData } from '@/lib/airtable'
import { callTriageAI } from '@/lib/ai-provider'

export const maxDuration = 180 // 3 mins — this is a deeper analysis

const FULL_ANALYSIS_SYSTEM_PROMPT = `You are a UK clinical guideline expert performing a COMPREHENSIVE review of an MRCGP SCA exam case.

You are given the COMPLETE case content — every single field. This typically includes fields like:
- Patient history / presenting complaint
- Examination findings
- Assessment / differential diagnosis
- Management / treatment plan
- Marking criteria / competency descriptors
- Explanation / model answer / discussion points
- Red flags / safety netting
- Follow-up / referral criteria
- Any other fields the case contains

YOUR JOB: Review EVERY field in the case for clinical accuracy against current UK guidelines. Look for issues in ALL fields, not just Assessment and Management. Common things to check include:

1. **Assessment/Diagnosis**: Are the differential diagnoses correct and complete? Are any outdated terms used?
2. **Management/Treatment**: Are drug names, doses, durations, and step-up pathways current? Are referral criteria correct?
3. **History/Presenting complaint**: Does the described presentation match the condition? Are any red flags missing that should be mentioned?
4. **Marking criteria**: Do the competency descriptors and expected candidate actions align with current guidelines? Are the "ideal" answers actually correct?
5. **Explanation/Discussion**: Are the educational explanations accurate? Do they reference current guidance?
6. **Safety netting/Follow-up**: Are the safety netting instructions and follow-up timelines correct per current guidance?
7. **Prescribing information**: Are any drug interactions, contraindications, or monitoring requirements outdated?
8. **Referral criteria**: Are 2-week-wait criteria, urgent referral thresholds etc. up to date?

DO NOT rewrite entire fields. Only output the specific snippets within each field that need to change.

FORMATTING RULES FOR suggestedText:
- The text will be pasted into Airtable which has rich text formatting enabled
- Airtable interprets standard markdown: **bold**, *italic*, - bullet points, 1. numbered lists
- EXCEPT for H4 headings: Airtable does NOT render #### as a heading. It displays the literal text "#### Heading Name" as a visual convention. You MUST keep #### exactly as-is in suggestedText if the original uses it.
- Match the exact formatting conventions of the original text in that field.
- suggestedText must be a DROP-IN REPLACEMENT for currentText — same formatting, same structure, just corrected content.

CLINICAL RULES:
- Only suggest changes supported by current UK guidelines
- You MUST search MULTIPLE source types for each clinical topic:
  1. NICE CKS (cks.nice.org.uk) — always search this first for primary care overview
  2. The RELEVANT SPECIALIST SOCIETY for the topic — this is MANDATORY, not optional. Examples:
     - Dermatology → search bad.org.uk (British Association of Dermatologists) AND pcds.org.uk (Primary Care Dermatology Society)
     - Respiratory → search brit-thoracic.org.uk (BTS) AND asthma.org.uk
     - Cardiology → search escardio.org AND bhf.org.uk
     - Women's health → search rcog.org.uk AND thebms.org.uk AND fsrh.org
     - Mental health → search rcpsych.ac.uk AND bap.org.uk
     - Gastro → search bsg.org.uk
     - Rheumatology → search rheumatology.org.uk
     - Endocrine → search british-thyroid-association.org AND abcd.care
     - ENT → search entuk.org
     - Urology → search baus.org.uk
     - Sexual health → search bashh.org
     - Paediatrics → search rcpch.ac.uk
     (Use whichever are relevant to the specific case topic)
  3. BNF (bnf.nice.org.uk) — for any prescribing, dosing, or drug interaction queries
- Do NOT rely solely on NICE. Specialist societies often have more detailed and more current guidance on specific conditions.
- Be specific about what needs changing and why
- If a field is correct, don't include it in fieldChanges
- If the ENTIRE case is up-to-date across all fields, return an empty fieldChanges array

You may also use the triage summary (if provided) to focus on known issues, but you MUST also look beyond the triage findings at all other fields.

Respond ONLY with a valid JSON object (no markdown fences, no preamble):
{
  "verdict": "up-to-date" | "changes-needed",
  "summary": "A brief paragraph summarising what needs updating across the case, or confirming it is correct. Mention which fields are affected.",
  "fieldChanges": [
    {
      "fieldName": "The exact Airtable field name where this text appears, e.g. Assessment, Management, Marking Criteria, Explanation, History, etc.",
      "currentText": "The EXACT current text snippet that needs changing — copy it verbatim from the case content, including any markdown formatting (####, **, - etc). Include enough surrounding context (a full paragraph or section) so the reviewer can locate it.",
      "issue": "What is wrong with this text and why it needs changing — reference the specific guideline and how it applies to this case",
      "suggestedText": "The replacement text, formatted identically to the original but with the clinical content corrected. Must be a direct drop-in replacement.",
      "confidence": "high" | "medium" | "low",
      "source": "URL of the guideline that supports this change"
    }
  ],
  "sources": [
    {
      "title": "Short descriptive title, e.g. NICE CKS: Acne vulgaris",
      "url": "The actual URL you accessed",
      "finding": "One sentence summary of what this source confirmed or contradicted"
    }
  ]
}

IMPORTANT:
- fieldName must be the EXACT Airtable field name as shown in the case content (e.g. "Assessment", "Management", "Marking Criteria", "Explanation").
- Each fieldChange should cover ONE specific issue. If multiple issues exist in one paragraph, include the whole paragraph and fix them all.
- currentText must be an EXACT match to what appears in the case — the reviewer will use find-and-replace.
- If nothing needs changing in any field, return "verdict": "up-to-date" with an empty fieldChanges array.`

export async function POST(req: NextRequest) {
  try {
    const { caseNumber, extraContext } = await req.json()

    if (!caseNumber) {
      return NextResponse.json({ error: 'Missing caseNumber' }, { status: 400 })
    }

    // Load triage result (has stored case data + triage findings)
    const triageResult = await getTriageResult(String(caseNumber))

    // Get the full case fields — prefer stored data, fall back to fresh Airtable fetch
    let fullFields: Record<string, string> | null = triageResult?.fullCaseFields ?? null

    if (!fullFields) {
      const caseData = await getCaseData(String(caseNumber))
      if (!caseData || !caseData.fields) {
        return NextResponse.json({ error: 'Case not found in Airtable or triage store' }, { status: 404 })
      }
      fullFields = caseData.fields
    }

    if (!fullFields || Object.keys(fullFields).length === 0) {
      return NextResponse.json({ error: 'No fields found for this case' }, { status: 400 })
    }

    // Build the full case content — EVERY field, clearly labelled
    const fieldEntries = Object.entries(fullFields)
    const allFieldsText = fieldEntries
      .map(([k, v]) => `### Field: ${k}\n${v}`)
      .join('\n\n---\n\n')

    const fieldNames = fieldEntries.map(([k]) => k).join(', ')

    // Build the triage context (if available from a previous scan)
    const triageContext = triageResult && triageResult.status !== 'pending'
      ? `PREVIOUS TRIAGE RESULT:
Status: ${triageResult.status}
Summary: ${triageResult.summary}
Sources checked: ${triageResult.citedUrls.join(', ')}

Use this as a starting point but review ALL fields comprehensively — the triage only checked Assessment and Management.`
      : 'No previous triage data available — perform a full review of all fields.'

    const userPrompt = `CASE ${caseNumber}

Fields present in this case: ${fieldNames}

${triageContext}

---

COMPLETE CASE CONTENT (every field):

${allFieldsText}

---
${extraContext ? `
ADDITIONAL CONTEXT FROM REVIEWER:
${extraContext}

---
` : ''}
Review EVERY field in this case for clinical accuracy against current UK guidelines. You MUST search:
1. NICE CKS for the main condition
2. The relevant specialist society guidelines (e.g. BAD/PCDS for dermatology, BTS for respiratory, etc.)
3. BNF if any prescribing or dosing is mentioned

Return specific before/after changes for any text that needs correcting, across ANY field. Do NOT rewrite entire fields — just the specific snippets that need updating.`

    // More searches needed — NICE CKS + specialist society + BNF minimum
    const maxSearches = parseInt(process.env.FULL_ANALYSIS_MAX_SEARCHES ?? process.env.TRIAGE_MAX_SEARCHES ?? '12')
    const aiResult = await callTriageAI(FULL_ANALYSIS_SYSTEM_PROMPT, userPrompt, maxSearches)

    // Parse the JSON response
    let parsed: any
    try {
      let clean = aiResult.textOutput
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .replace(/<cite[^>]*>/g, '')
        .replace(/<\/cite>/g, '')
        .trim()

      try {
        parsed = JSON.parse(clean)
      } catch {
        const jsonMatch = clean.match(/\{[\s\S]*"fieldChanges"\s*:[\s\S]*\}/)
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0])
        } else {
          throw new Error('No JSON found')
        }
      }
    } catch {
      return NextResponse.json({
        error: 'AI returned unparseable response',
        raw: aiResult.textOutput.slice(0, 3000),
      }, { status: 500 })
    }

    return NextResponse.json({
      ...parsed,
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
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
