// app/api/triage-case/route.ts
// Triage a single case against current UK guidelines.
// Uses the dual-provider abstraction (Anthropic or OpenAI based on env var).

import { NextRequest, NextResponse } from 'next/server'
import { getCaseData } from '@/lib/airtable'
import { callTriageAI } from '@/lib/ai-provider'
import { saveTriageResult, saveTriageMetadata, getTriageMetadata } from '@/lib/triage-store'
import { TRIAGE_SYSTEM_PROMPT, buildTriageUserPrompt } from '@/lib/triage-prompt'
import type { TriageResult } from '@/lib/triage-store'

export const maxDuration = 120 // Allow up to 2 mins for web search

export async function POST(req: NextRequest) {
  try {
    const { caseNumber, batchMode } = await req.json()

    if (!caseNumber) {
      return NextResponse.json({ error: 'Missing caseNumber' }, { status: 400 })
    }

    // Fetch case data from Airtable
    const caseData = await getCaseData(String(caseNumber))
    if (!caseData || !caseData.fields) {
      const errorResult: TriageResult = {
        caseNumber: String(caseNumber),
        status: 'error',
        summary: 'Case not found in Airtable',
        searchCount: 0,
        citedUrls: [],
        provider: '',
        model: '',
        timestamp: new Date().toISOString(),
      }
      await saveTriageResult(errorResult)
      return NextResponse.json(errorResult)
    }

    // Extract assessment and management fields
    const fields = caseData.fields
    let assessmentText = ''
    let managementText = ''

for (const [key, value] of Object.entries(fields)) {
    if (key === 'Assessment') {
        assessmentText += (assessmentText ? '\n\n' : '') + value
    }
    if (key === 'Management') {
        managementText += (managementText ? '\n\n' : '') + value
    }
}

    if (!assessmentText && !managementText) {
      const errorResult: TriageResult = {
        caseNumber: String(caseNumber),
        status: 'error',
        summary: 'No Assessment or Management fields found in this case',
        searchCount: 0,
        citedUrls: [],
        provider: '',
        model: '',
        timestamp: new Date().toISOString(),
      }
      await saveTriageResult(errorResult)
      return NextResponse.json(errorResult)
    }

    // Build prompt and call AI
    const userPrompt = buildTriageUserPrompt(String(caseNumber), assessmentText, managementText)
    const maxSearches = parseInt(process.env.TRIAGE_MAX_SEARCHES ?? '3')

    const aiResult = await callTriageAI(TRIAGE_SYSTEM_PROMPT, userPrompt, maxSearches)

    // Parse the JSON response
    let parsed: any
    try {
      const clean = aiResult.textOutput.replace(/```json|```/g, '').trim()
      parsed = JSON.parse(clean)
    } catch {
      // If parsing fails, save as review-needed with the raw text
      const fallback: TriageResult = {
        caseNumber: String(caseNumber),
        status: 'review-needed',
        summary: `AI returned unparseable response. Raw: ${aiResult.textOutput.slice(0, 2000)}`,
        searchCount: aiResult.searchCount,
        citedUrls: aiResult.citedUrls,
        provider: aiResult.provider,
        model: aiResult.model,
        timestamp: new Date().toISOString(),
assessmentSnippet: assessmentText,
managementSnippet: managementText,
      }
      await saveTriageResult(fallback)
      return NextResponse.json(fallback)
    }

    // Validate status
    const validStatuses = ['up-to-date', 'review-needed', 'outdated']
    const status = validStatuses.includes(parsed.status) ? parsed.status : 'review-needed'

    const result: TriageResult = {
      caseNumber: String(caseNumber),
      status,
      summary: `${parsed.topic ? `**${parsed.topic}** — ` : ''}${parsed.summary ?? 'No summary provided'}${parsed.confidence ? ` (Confidence: ${parsed.confidence})` : ''}`,
      searchCount: aiResult.searchCount,
      citedUrls: parsed.keySource
        ? [parsed.keySource, ...aiResult.citedUrls.filter(u => u !== parsed.keySource)]
        : aiResult.citedUrls,
      provider: aiResult.provider,
      model: aiResult.model,
      timestamp: new Date().toISOString(),
assessmentSnippet: assessmentText,
managementSnippet: managementText,
    }

    await saveTriageResult(result)

    // Update metadata if in batch mode
    if (batchMode) {
      const meta = await getTriageMetadata()
      meta.casesScanned = (meta.casesScanned ?? 0) + 1
      if (meta.casesScanned >= meta.totalCases) {
        meta.scanInProgress = false
        meta.lastScanCompleted = new Date().toISOString()
      }
      await saveTriageMetadata(meta)
    }

    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
