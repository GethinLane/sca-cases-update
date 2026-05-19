// lib/feedback-analysis-store.ts
// Vercel Blob storage for the two-stage feedback analysis flow.
// One Stage-1 record and one Stage-2 record per feedbackId.
// Fails loudly if BLOB_READ_WRITE_TOKEN is unset — same pattern as triage-store.

import { put, list, get, del } from '@vercel/blob'
import type { CaseDataStructured } from './airtable'

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  throw new Error(
    'BLOB_READ_WRITE_TOKEN is not set. Feedback analysis store requires Vercel Blob storage. ' +
    'Set this env var locally (via `vercel env pull`) and in your deployment environment.',
  )
}

export interface FeedbackFlaggedCell {
  recordId: string
  fieldName: string
  rowIndex: number
  issue: string
  severity: 'high' | 'medium' | 'low'
}

export interface FeedbackTriageSource {
  title: string
  url: string
  finding: string
}

export interface FeedbackTriageResult {
  caseScenario: string
  summary: string
  sources: FeedbackTriageSource[]
  verdict: 'valid' | 'partial' | 'invalid' | 'uncertain'
  verdictReason: string
  verdictSelfCheck: {
    flaggedCellsCount: number
    summaryAcknowledgesProblem: boolean
    verdictRule: string
  }
  flaggedCells: FeedbackFlaggedCell[]
  emailSubject: string
  emailResponse: string
}

export interface FeedbackTriageRecord {
  feedbackId: string
  caseNumber: string
  triagedAt: string
  triage: FeedbackTriageResult
  caseSnapshot: CaseDataStructured
  citedUrls: string[]
  provider: string
  model: string
  searchCount: number
}

export interface FeedbackRewriteEntry {
  recordId: string
  fieldName: string
  rowIndex: number
  currentText: string
  suggestedText: string
  rationale: string
  confidence: 'high' | 'medium' | 'low'
  sourceUrl?: string
  appliedAt?: string
}

export interface FeedbackRewriteRecord {
  feedbackId: string
  draftedAt: string
  scope: 'flagged-only' | 'whole-case'
  rewrites: FeedbackRewriteEntry[]
  citedUrls: string[]
  provider: string
  model: string
  searchCount: number
}

// ─── Blob helpers ─────────────────────────────────────────────────

function triagePath(feedbackId: string): string {
  return `feedback-analysis/triage-${feedbackId}.json`
}

function rewritesPath(feedbackId: string): string {
  return `feedback-analysis/rewrites-${feedbackId}.json`
}

async function readBlob<T>(path: string): Promise<T | null> {
  try {
    const { blobs } = await list({ prefix: path, limit: 1 })
    const blob = blobs.find(b => b.pathname === path)
    if (!blob) return null

    const res = await get(blob.url, { access: 'private' })
    if (!res || res.statusCode !== 200) return null

    const text = await new Response(res.stream).text()
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

async function writeBlob(path: string, data: unknown): Promise<void> {
  await put(path, JSON.stringify(data), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  })
}

// ─── Public API ───────────────────────────────────────────────────

export async function saveTriage(record: FeedbackTriageRecord): Promise<void> {
  await writeBlob(triagePath(record.feedbackId), record)
}

export async function getTriage(feedbackId: string): Promise<FeedbackTriageRecord | null> {
  return await readBlob<FeedbackTriageRecord>(triagePath(feedbackId))
}

export async function saveRewrites(record: FeedbackRewriteRecord): Promise<void> {
  await writeBlob(rewritesPath(record.feedbackId), record)
}

export async function getRewrites(feedbackId: string): Promise<FeedbackRewriteRecord | null> {
  return await readBlob<FeedbackRewriteRecord>(rewritesPath(feedbackId))
}

export async function markRewriteApplied(
  feedbackId: string,
  recordId: string,
  fieldName: string,
): Promise<void> {
  const existing = await getRewrites(feedbackId)
  if (!existing) {
    throw new Error(`No rewrite record found for feedback ${feedbackId}`)
  }
  const appliedAt = new Date().toISOString()
  let matched = false
  existing.rewrites = existing.rewrites.map(r => {
    if (r.recordId === recordId && r.fieldName === fieldName) {
      matched = true
      return { ...r, appliedAt }
    }
    return r
  })
  if (!matched) {
    throw new Error(
      `No rewrite found for (recordId=${recordId}, fieldName=${fieldName}) in feedback ${feedbackId}`,
    )
  }
  await saveRewrites(existing)
}

export async function clearTriage(feedbackId: string): Promise<void> {
  try {
    const path = triagePath(feedbackId)
    const { blobs } = await list({ prefix: path, limit: 1 })
    const blob = blobs.find(b => b.pathname === path)
    if (blob) await del(blob.url)
  } catch { /* ignore */ }
}

export async function clearRewrites(feedbackId: string): Promise<void> {
  try {
    const path = rewritesPath(feedbackId)
    const { blobs } = await list({ prefix: path, limit: 1 })
    const blob = blobs.find(b => b.pathname === path)
    if (blob) await del(blob.url)
  } catch { /* ignore */ }
}
