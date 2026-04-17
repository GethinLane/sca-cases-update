// app/api/sync-cases/route.ts
// Primes the triage store with one entry per case so the dashboard has a complete list.
// Only stores short snippets for the sidebar preview — full content is re-fetched from
// Airtable at analysis time to avoid stale data.

import { NextRequest, NextResponse } from 'next/server'
import { getCaseData } from '@/lib/airtable'
import { saveTriageResult, getTriageResult, saveTriageMetadata, getTriageMetadata } from '@/lib/triage-store'

export const maxDuration = 300

export async function POST(req: NextRequest) {
  try {
    const totalCases = parseInt(process.env.TOTAL_CASE_COUNT ?? '355')

    const url = new URL(req.url)
    const startCase = parseInt(url.searchParams.get('start') ?? '1')
    const limit = parseInt(url.searchParams.get('limit') ?? String(totalCases))
    const endCase = Math.min(startCase + limit - 1, totalCases)

    let synced = 0
    let skipped = 0
    const errors: string[] = []
    const batchSize = 2
    const delayMs = 2000

    for (let i = startCase; i <= endCase; i += batchSize) {
      const batch: number[] = []
      for (let j = i; j < i + batchSize && j <= endCase; j++) batch.push(j)

      const batchResults = await Promise.allSettled(
        batch.map(async (caseNum) => {
          const data = await getCaseData(String(caseNum))
          return { caseNum, data }
        }),
      )

      for (const result of batchResults) {
        if (result.status === 'rejected') {
          errors.push(`Case batch error: ${result.reason?.message ?? 'Unknown'}`)
          continue
        }

        const { caseNum, data } = result.value
        if (!data || !data.fields) {
          errors.push(`Case ${caseNum}: no data returned from Airtable`)
          skipped++
          continue
        }

        let assessmentText = ''
        let managementText = ''
        for (const [key, value] of Object.entries(data.fields)) {
          if (key === 'Assessment') assessmentText += (assessmentText ? '\n\n' : '') + value
          if (key === 'Management') managementText += (managementText ? '\n\n' : '') + value
        }

        // Keep only SHORT snippets for sidebar display. Full content re-fetched at analysis time.
        const assessmentSnippet = assessmentText.slice(0, 4000)
        const managementSnippet = managementText.slice(0, 4000)

        const existing = await getTriageResult(String(caseNum))
        if (existing && existing.status !== 'pending') {
          // Preserve existing triage status, just refresh the snippets.
          existing.assessmentSnippet = assessmentSnippet
          existing.managementSnippet = managementSnippet
          await saveTriageResult(existing)
        } else {
          await saveTriageResult({
            caseNumber: String(caseNum),
            status: 'pending',
            summary: 'Not yet scanned',
            searchCount: 0,
            citedUrls: [],
            provider: '',
            model: '',
            timestamp: new Date().toISOString(),
            assessmentSnippet,
            managementSnippet,
          })
        }
        synced++
      }

      if (i + batchSize <= endCase) await new Promise(r => setTimeout(r, delayMs))
    }

    const meta = await getTriageMetadata()
    meta.totalCases = totalCases
    await saveTriageMetadata(meta)

    return NextResponse.json({
      synced,
      skipped,
      total: endCase - startCase + 1,
      range: { start: startCase, end: endCase },
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
