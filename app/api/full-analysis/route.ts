// app/api/full-analysis/route.ts
// Takes a case number, loads its triage result (with stored case data),
// and runs a deep analysis that produces updated Assessment/Management
// text in Airtable-compatible format (#### for H4 headings).

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

Your job: Produce UPDATED versions of the Assessment and Management fields that correct any guideline issues found in the triage, while preserving the existing structure and format.

FORMATTING RULES — THIS IS CRITICAL:
- The text will be pasted directly into Airtable with rich text formatting enabled
- Use #### (four hashes) for H4 headings — this is the ONLY heading level used in these cases
- Preserve ALL existing headings, sections and structure from the original text
- Only change the specific clinical content that needs updating
- Keep the same writing style and tone as the original
- Use bullet points (- ) where the original uses them
- Use numbered lists (1. ) where the original uses them
- Bold text uses **double asterisks**
- If a section is clinically correct, keep it EXACTLY as-is — do not rephrase correct content

CLINICAL RULES:
- Only make changes that are supported by current UK guidelines (NICE CKS, BNF, NICE guidelines)
- Reference the triage findings to focus your changes
- Search the web to verify any updates you make — always check cks.nice.org.uk
- Be specific about what you changed and why
- If the triage found the case is up-to-date, confirm this and return the original text unchanged

Respond ONLY with a valid JSON object (no markdown fences, no preamble):
{
  "assessmentUpdated": true | false,
  "managementUpdated": true | false,
  "updatedAssessment": "The full updated Assessment text in Airtable format, or the original if no changes needed",
  "updatedManagement": "The full updated Management text in Airtable format, or the original if no changes needed",
  "changesMade": [
    {
      "field": "Assessment" | "Management",
      "section": "Which heading/section was changed",
      "description": "What was changed and why",
      "source": "URL of the guideline that supports this change"
    }
  ],
  "summary": "A brief paragraph summarising what was updated and why, or confirming the case is correct"
}`

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

CURRENT ASSESSMENT TEXT (this is what you need to update if needed):
${assessmentText}

---

CURRENT MANAGEMENT TEXT (this is what you need to update if needed):
${managementText}

---
${extraContext ? `
ADDITIONAL CONTEXT FROM REVIEWER:
${extraContext}

---
` : ''}
Please review this case using the triage findings above. Search the web to verify the current guidelines for the relevant condition. Then produce updated Assessment and Management text that corrects any issues, preserving the exact formatting (#### for H4 headings, bullet points, numbered lists etc). If the case is correct, return the original text unchanged.`

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
        const jsonMatch = clean.match(/\{[\s\S]*"updatedAssessment"\s*:[\s\S]*"updatedManagement"\s*:[\s\S]*\}/)
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
