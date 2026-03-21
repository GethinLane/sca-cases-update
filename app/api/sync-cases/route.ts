// app/api/sync-cases/route.ts
// Fetches case Assessment + Management fields from Airtable.
// Stores each case as its own blob file — no race conditions.
// Airtable rate limit: 5 req/s. We do 2 req every 2s = 1 req/s (safe margin).

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
      for (let j = i; j < i + batchSize && j <= endCase; j++) {
        batch.push(j)
      }

      const batchResults = await Promise.allSettled(
        batch.map(async (caseNum) => {
          const data = await getCaseData(String(caseNum))
          return { caseNum, data }
        })
      )

      for (const result of batchResults) {
        if (result.status === 'rejected') {
          errors.push(`Case ${batch}: ${result.reason?.message ?? 'Unknown error'}`)
          continue
        }

        const { caseNum, data } = result.value
        if (!data || !data.fields) {
          errors.push(`Case ${caseNum}: no data returned from Airtable`)
          skipped++
          continue
        }

        // Extract ONLY Assessment and Management fields (exact match)
        let assessmentText = ''
        let managementText = ''

        for (const [key, value] of Object.entries(data.fields)) {
          if (key === 'Assessment') {
            assessmentText += (assessmentText ? '\n\n' : '') + value
          }
          if (key === 'Management') {
            managementText += (managementText ? '\n\n' : '') + value
          }
        }

        // Check if we already have a triage result for this case
        const existing = await getTriageResult(String(caseNum))

        if (existing && existing.status !== 'pending') {
          // Preserve existing triage status, just update the case text
          existing.assessmentSnippet = assessmentText
          existing.managementSnippet = managementText
          existing.fullCaseFields = data.fields
          await saveTriageResult(existing)
        } else {
          // New entry
          await saveTriageResult({
            caseNumber: String(caseNum),
            status: 'pending',
            summary: 'Not yet scanned',
            searchCount: 0,
            citedUrls: [],
            provider: '',
            model: '',
            timestamp: new Date().toISOString(),
            assessmentSnippet: assessmentText,
            managementSnippet: managementText,
            fullCaseFields: data.fields,
          })
        }
        synced++
      }

      // Rate limit pause between batches
      if (i + batchSize <= endCase) {
        await new Promise(r => setTimeout(r, delayMs))
      }
    }

    // Update metadata
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
