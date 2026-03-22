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

═══════════════════════════════════════════════════════════════
AIRTABLE RICH TEXT FORMATTING RULES — CRITICAL
═══════════════════════════════════════════════════════════════

Both currentText and suggestedText MUST use Airtable-compatible rich text markdown so the reviewer can copy-paste directly into Airtable with no reformatting needed.

Airtable's rich text fields support the following markdown:

HEADINGS:
  ## Heading 2          →  renders as H2 in Airtable
  ### Heading 3         →  renders as H3 in Airtable
  #### Heading 4        →  Airtable does NOT render H4 as a heading. It displays the literal text "#### Heading Name". Many of our cases use #### as a VISUAL CONVENTION for sub-headings. You MUST keep #### exactly as-is if the original text uses it. Never convert #### to ##, ###, **, or any other format.

INLINE FORMATTING:
  **bold text**         →  bold
  *italic text*         →  italic
  ~~strikethrough~~     →  strikethrough
  \`inline code\`        →  inline code
  [link text](url)      →  hyperlink

LISTS:
  - item                →  bullet point (use hyphen followed by a space)
  1. item               →  numbered list

BLOCKQUOTES:
  > quoted text         →  blockquote

CODE BLOCKS:
  \`\`\`                   →  code block (triple backticks on own line)

LINE BREAKS:
  A blank line between paragraphs creates a paragraph break in Airtable.
  A single newline within a block keeps text in the same visual block.

═══════════════════════════════════════════════════════════════
HOW TO APPLY THESE RULES
═══════════════════════════════════════════════════════════════

1. currentText: Copy the EXACT text from the case content, preserving ALL original markdown formatting — every **, *, ##, ###, ####, -, 1., >, blank line, etc. The reviewer will use find-and-replace, so this must be a character-perfect match.

2. suggestedText: Write the corrected replacement using the SAME formatting conventions as the original. Specifically:
   - If the original uses **bold** for drug names, your replacement must also use **bold** for drug names
   - If the original uses - for bullet points, your replacement must also use - for bullet points
   - If the original uses #### for sub-headings, your replacement must also use #### for sub-headings
   - If the original uses ### for section headers, your replacement must also use ### for section headers
   - If the original uses numbered lists (1. 2. 3.), your replacement must also use numbered lists
   - If the original uses > for blockquotes, your replacement must also use > for blockquotes
   - Match indentation, spacing, and line break patterns from the original
   - The suggestedText must be a DROP-IN REPLACEMENT: same structure, same formatting, just corrected clinical content

3. NEVER strip formatting from currentText or suggestedText. If the original has rich formatting, the replacement must too.

4. NEVER convert one formatting style to another (e.g. don't convert #### to ### or ** to plain text).

5. When ADDING new content (e.g. adding a missing bullet point to an existing list), match the formatting style of the surrounding content.

═══════════════════════════════════════════════════════════════

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
      "currentText": "The EXACT current text snippet that needs changing — copy it VERBATIM from the case content, preserving ALL markdown formatting (####, ###, ##, **, *, -, 1., >, blank lines, etc). Include enough surrounding context (a full paragraph or section) so the reviewer can locate it and use find-and-replace.",
      "issue": "What is wrong with this text and why it needs changing — reference the specific guideline and how it applies to this case",
      "suggestedText": "The replacement text, formatted IDENTICALLY to the original using Airtable-compatible markdown (see formatting rules above). Must be a direct drop-in replacement with the same heading styles, bold patterns, list formats, and spacing — just with corrected clinical content.",
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
- currentText must be an EXACT match to what appears in the case — the reviewer will use find-and-replace. Preserve every character of formatting.
- suggestedText must use the SAME Airtable-compatible markdown formatting as the original text. It should be ready to paste directly into Airtable with no manual reformatting needed.
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

    // Cap extra context to avoid blowing token limits when users paste large documents
    const trimmedContext = extraContext ? extraContext.slice(0, 8000) : ''

    const userPrompt = `CASE ${caseNumber}

Fields present in this case: ${fieldNames}

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
Review EVERY field in this case for clinical accuracy against current UK guidelines. You MUST search:
1. NICE CKS for the main condition
2. The relevant specialist society guidelines (e.g. BAD/PCDS for dermatology, BTS for respiratory, etc.)
3. BNF if any prescribing or dosing is mentioned

IMPORTANT: Both currentText and suggestedText in your response MUST preserve the full Airtable-compatible rich text markdown formatting (##, ###, ####, **bold**, *italic*, - bullet points, 1. numbered lists, > blockquotes, blank lines for paragraph breaks). The suggestedText must be ready to paste directly into an Airtable rich text field with zero reformatting.

Return specific before/after changes for any text that needs correcting, across ANY field. Do NOT rewrite entire fields — just the specific snippets that need updating.`

    // More searches needed — NICE CKS + specialist society + BNF minimum
    // Use Sonnet for full analysis (more capable than Haiku for complex multi-field review)
    const maxSearches = parseInt(process.env.FULL_ANALYSIS_MAX_SEARCHES ?? process.env.TRIAGE_MAX_SEARCHES ?? '12')
    const fullAnalysisModel = process.env.FULL_ANALYSIS_MODEL ?? 'claude-sonnet-4-6'
    const aiResult = await callTriageAI(FULL_ANALYSIS_SYSTEM_PROMPT, userPrompt, maxSearches, fullAnalysisModel)

    // Parse the JSON response — Sonnet 4.6 may include preamble text before/after the JSON
    let parsed: any
    try {
      let clean = aiResult.textOutput
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .replace(/<cite[^>]*?\/>/g, '')
        .replace(/<cite[^>]*>/g, '')
        .replace(/<\/cite>/g, '')
        .trim()

      // Attempt 1: direct parse (clean response)
      try {
        parsed = JSON.parse(clean)
      } catch {
        // Attempt 2: find JSON object that contains our expected fields
        // Use a balanced brace approach instead of greedy regex
        const jsonStart = clean.indexOf('{')
        if (jsonStart !== -1) {
          let depth = 0
          let jsonEnd = -1
          for (let i = jsonStart; i < clean.length; i++) {
            if (clean[i] === '{') depth++
            if (clean[i] === '}') depth--
            if (depth === 0) { jsonEnd = i; break }
          }
          if (jsonEnd !== -1) {
            const jsonStr = clean.slice(jsonStart, jsonEnd + 1)
            try {
              parsed = JSON.parse(jsonStr)
            } catch {
              // Attempt 3: try to fix common issues — trailing commas, unescaped newlines in strings
              const fixed = jsonStr
                .replace(/,\s*([}\]])/g, '$1')  // trailing commas
                .replace(/\n/g, '\\n')            // unescaped newlines (crude but catches most)
              try {
                parsed = JSON.parse(fixed)
              } catch {
                throw new Error('JSON parse failed after all attempts')
              }
            }
          } else {
            throw new Error('No matching closing brace found')
          }
        } else {
          throw new Error('No JSON object found in response')
        }
      }
    } catch (parseErr: any) {
      console.error('JSON parse error:', parseErr.message)
      console.error('Raw text (first 2000 chars):', aiResult.textOutput.slice(0, 2000))
      return NextResponse.json({
        error: 'AI returned unparseable response',
        parseError: parseErr.message,
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
    console.error('Full analysis error:', err)
    return NextResponse.json({
      error: err.message ?? 'Unknown error',
      detail: err.cause?.message ?? err.stack?.slice(0, 500) ?? '',
    }, { status: 500 })
  }
}
