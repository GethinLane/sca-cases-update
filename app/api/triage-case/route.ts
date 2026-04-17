// app/api/triage-case/route.ts
// Triage a single case against current UK guidelines using structured outputs.

import { NextRequest, NextResponse } from 'next/server'
import { getCaseData } from '@/lib/airtable'
import { callTriageAI } from '@/lib/ai-provider'
import { saveTriageResult, saveTriageMetadata, getTriageMetadata } from '@/lib/triage-store'
import { TRIAGE_SYSTEM_PROMPT, buildTriageUserPrompt } from '@/lib/triage-prompt'
import { TRIAGE_SCHEMA } from '@/lib/schemas'
import type { TriageResult } from '@/lib/triage-store'

export const maxDuration = 120

export async function POST(req: NextRequest) {
  try {
    const { caseNumber, batchMode } = await req.json()
    if (!caseNumber) return NextResponse.json({ error: 'Missing caseNumber' }, { status: 400 })

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

    let assessmentText = ''
    let managementText = ''
    for (const [key, value] of Object.entries(caseData.fields)) {
      if (key === 'Assessment') assessmentText += (assessmentText ? '\n\n' : '') + value
      if (key === 'Management') managementText += (managementText ? '\n\n' : '') + value
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

    const userPrompt = buildTriageUserPrompt(String(caseNumber), assessmentText, managementText)
    const maxSearches = parseInt(process.env.TRIAGE_MAX_SEARCHES ?? '3')
    const effort = process.env.OPENAI_TRIAGE_EFFORT ?? process.env.OPENAI_REASONING_EFFORT ?? 'medium'

    let aiResult
    try {
      aiResult = await callTriageAI(TRIAGE_SYSTEM_PROMPT, userPrompt, {
        schema: TRIAGE_SCHEMA,
        schemaName: 'submit_analysis',
        maxSearches,
        effortOverride: effort,
      })
    } catch (err: any) {
      const fallback: TriageResult = {
        caseNumber: String(caseNumber),
        status: 'review-needed',
        summary: `Triage failed: ${err.message}`,
        searchCount: 0,
        citedUrls: [],
        provider: '',
        model: '',
        timestamp: new Date().toISOString(),
        assessmentSnippet: assessmentText.slice(0, 4000),
        managementSnippet: managementText.slice(0, 4000),
      }
      await saveTriageResult(fallback)
      return NextResponse.json(fallback)
    }

    const parsed = aiResult.parsed
    const validStatuses = ['up-to-date', 'review-needed', 'outdated']
    const status = validStatuses.includes(parsed.status) ? parsed.status : 'review-needed'

    const result: TriageResult = {
      caseNumber: String(caseNumber),
      status,
      summary: `${parsed.topic ? `**${parsed.topic}** — ` : ''}${parsed.summary ?? 'No summary provided'}${parsed.confidence ? ` (Confidence: ${parsed.confidence})` : ''}`,
      searchCount: aiResult.searchCount,
      citedUrls: parsed.keySource
        ? [parsed.keySource, ...aiResult.citedUrls.filter((u: string) => u !== parsed.keySource)]
        : aiResult.citedUrls,
      provider: aiResult.provider,
      model: aiResult.model,
      timestamp: new Date().toISOString(),
      // Keep short snippets so the sidebar has something to show without re-fetching Airtable.
      assessmentSnippet: assessmentText.slice(0, 4000),
      managementSnippet: managementText.slice(0, 4000),
    }

    await saveTriageResult(result)

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
