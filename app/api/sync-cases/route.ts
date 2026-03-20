// app/api/sync-cases/route.ts
// Fetches case Assessment + Management fields from Airtable and stores in Blob.
// Designed to be called in chunks from the frontend to avoid Vercel timeout.
// 40 cases per chunk × batches of 4 with 1.2s pause = ~12s per chunk (safe on Hobby).
// Airtable rate limit: 5 requests/second. We do ~3.3 req/s.

import { NextRequest, NextResponse } from 'next/server'
import { getCaseData } from '@/lib/airtable'
import { readStore, writeStore } from '@/lib/triage-store'
import type { TriageResult } from '@/lib/triage-store'

export const maxDuration = 300 // Works on Hobby plan — frontend chunks the work

export async function POST(req: NextRequest) {
  try {
    const totalCases = parseInt(process.env.TOTAL_CASE_COUNT ?? '355')

    // Support chunked syncing: ?start=1&limit=50
    const url = new URL(req.url)
    const startCase = parseInt(url.searchParams.get('start') ?? '1')
    const limit = parseInt(url.searchParams.get('limit') ?? String(totalCases))
    const endCase = Math.min(startCase + limit - 1, totalCases)

    // Read the entire store ONCE at the start
    const store = await readStore()

    let synced = 0
    const errors: string[] = []
    const batchSize = 4
    const delayMs = 1200 // 1.2s between batches = well under 5 req/s

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

      // Process results in memory (no Blob writes mid-loop)
      for (const result of batchResults) {
        if (result.status === 'rejected') {
          errors.push(result.reason?.message ?? 'Unknown error')
          continue
        }

        const { caseNum, data } = result.value
        if (!data || !data.fields) continue

        // Extract assessment and management fields
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

        const caseKey = String(caseNum)
        const existing = store.results[caseKey]

        if (existing) {
          // Update snippets only, preserve triage status
          existing.assessmentSnippet = assessmentText
          existing.managementSnippet = managementText
        } else {
          // New pending entry
          store.results[caseKey] = {
            caseNumber: caseKey,
            status: 'pending',
            summary: 'Not yet scanned',
            searchCount: 0,
            citedUrls: [],
            provider: '',
            model: '',
            timestamp: new Date().toISOString(),
            assessmentSnippet: assessmentText,
            managementSnippet: managementText,
          }
        }
        synced++
      }

      // Rate limit pause between batches (skip after last batch)
      if (i + batchSize <= endCase) {
        await new Promise(r => setTimeout(r, delayMs))
      }
    }

    // Update metadata
    store.metadata.totalCases = totalCases

    // Write the entire store ONCE at the end
    await writeStore(store)

    return NextResponse.json({
      synced,
      total: totalCases,
      range: { start: startCase, end: endCase },
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
      nextChunk: endCase < totalCases
        ? `/api/sync-cases?start=${endCase + 1}&limit=${limit}`
        : null,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
