// app/api/full-analysis/route.ts
// Takes a case number, loads its triage result (with stored case data),
// and runs a deep analysis that returns field-by-field change suggestions
// (currentText → suggestedText) — NOT the full replacement text.

import { NextRequest, NextResponse } from 'next/server'
import { getTriageResult } from '@/lib/triage-store'
import { getCaseData } from '@/lib/airtable'
import { callTriageAI } from '@/lib/ai-provider'

export const maxDuration = 180 // 3 mins — this is a deeper analysis

const FULL_ANALYSIS_SYSTEM_PROMPT = `You are a UK clinical guideline expert reviewing MRCGP SCA exam cases.

You have been given:
1. The FULL case content (all fields from the case)
2. A triage summary from a previous scan that identified potential guideline issues
3. The current Assessment and Management text from the case

Your job: Identify ONLY the specific parts of the Assessment and/or Management that need changing, and provide exact before/after text for each change.

DO NOT rewrite the entire field. Only output the specific snippets that need to change.

FORMATTING RULES FOR suggestedText:
- The text will be pasted into Airtable which has rich text formatting enabled
- Airtable interprets standard markdown: **bold**, *italic*, - bullet points, 1. numbered lists
- EXCEPT for H4 headings: Airtable does NOT render #### as a heading. It displays the literal text "#### Heading Name" as a visual heading convention. You MUST keep #### exactly as-is in suggestedText if the original uses it.
- Match the exact formatting conventions of the original: if it uses ####, use ####. If it uses bold headings, use bold headings. If it uses bullets, use bullets.
- suggestedText must be a DROP-IN REPLACEMENT for currentText — same formatting style, same structure, just corrected content.

CLINICAL RULES:
- Only suggest changes that are supported by current UK guidelines (NICE CKS, BNF, NICE guidelines)
- Reference the triage findings to focus your changes
- Search the web to verify any changes you suggest — always check cks.nice.org.uk
- Be specific about what needs changing and why
- If the case is fully up-to-date, return an empty fieldChanges array

Respond ONLY with a valid JSON object (no markdown fences, no preamble):
{
  "verdict": "up-to-date" | "changes-needed",
  "summary": "A brief paragraph summarising what needs updating and why, or confirming the case is correct. Reference specific clinical details.",
  "fieldChanges": [
    {
      "fieldName": "Assessment" | "Management",
      "currentText": "The EXACT current text snippet that needs changing — copy it verbatim from the case content, including any markdown formatting (####, **, - etc). Include enough surrounding context (a full paragraph or section) so the reviewer can find it easily.",
      "issue": "What is wrong with this text and why it needs changing — reference the specific guideline",
      "suggestedText": "The replacement text, formatted identically to the original (same markdown style, same structure) but with the clinical content corrected. This should be a direct drop-in replacement for currentText.",
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
- Each fieldChange should cover ONE specific issue. If multiple sentences in a paragraph need changing, include the whole paragraph as currentText and fix all issues in suggestedText.
- currentText must be an EXACT match to what appears in the case — the reviewer will use find-and-replace.
- If nothing needs changing, return "verdict": "up-to-date" with an empty fieldChanges array.
- Keep the number of fieldChanges minimal — only what actually needs correcting.`

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
    let assessmentText = triageResult?.assessmentSnippet ?? ''
    let managementText = triageResult?.managementSnippet ?? ''

    if (!fullFields || !assessmentText) {
      // Fall back to fetching from Airtable directly
      const caseData = await getCaseData(String(caseNumber))
      if (!caseData || !caseData.fields) {
        return NextResponse.json({ error: 'Case not found in Airtable or triage store' }, { status: 404 })
      }
      fullFields = caseData.fields
      assessmentText = ''
      managementText = ''
      for (const [key, value] of Object.entries(fullFields)) {
        if (key === 'Assessment') assessmentText += (assessmentText ? '\n\n' : '') + value
        if (key === 'Management') managementText += (managementText ? '\n\n' : '') + value
      }
    }

    if (!assessmentText && !managementText) {
      return NextResponse.json({ error: 'No Assessment or Management fields found' }, { status: 400 })
    }

    // Build context from ALL case fields (not just assessment/management)
    const allFieldsText = Object.entries(fullFields)
      .map(([k, v]) => `### Field: ${k}\n${v}`)
      .join('\n\n---\n\n')
      .slice(0, 30000)

    // Build the triage context
    const triageContext = triageResult && triageResult.status !== 'pending'
      ? `TRIAGE STATUS: ${triageResult.status}
TRIAGE SUMMARY: ${triageResult.summary}
TRIAGE SOURCES: ${triageResult.citedUrls.join(', ')}`
      : 'No triage data available — perform a full review.'

    const userPrompt = `CASE ${caseNumber}

${triageContext}

---

FULL CASE CONTENT (all fields):
${allFieldsText}

---

CURRENT ASSESSMENT TEXT:
${assessmentText}

---

CURRENT MANAGEMENT TEXT:
${managementText}

---
${extraContext ? `
ADDITIONAL CONTEXT FROM REVIEWER:
${extraContext}

---
` : ''}
Review this case using the triage findings above. Search the web to verify the current guidelines. Then identify ONLY the specific text snippets that need changing and provide exact before/after replacements. Do NOT rewrite the entire fields — just the parts that need correcting.`

    const maxSearches = parseInt(process.env.TRIAGE_MAX_SEARCHES ?? '5')
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
