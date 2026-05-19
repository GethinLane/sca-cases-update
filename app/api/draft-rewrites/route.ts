// app/api/draft-rewrites/route.ts
// Stage 2 of the two-stage feedback flow.
// Opus 4.7 reads the Stage-1 triage + fresh case data and drafts a drop-in
// replacement for every target cell. Output is per-cell so the UI can apply
// individual rewrites with conflict detection.

import { NextRequest, NextResponse } from 'next/server'
import { callTriageAI } from '@/lib/ai-provider'
import { DRAFT_REWRITES_SCHEMA } from '@/lib/schemas'
import { getCaseDataStructured } from '@/lib/airtable'
import {
  getTriage,
  saveRewrites,
  getRewrites,
  type FeedbackRewriteEntry,
  type FeedbackRewriteRecord,
} from '@/lib/feedback-analysis-store'

export const maxDuration = 300

// Opus 4.7 — see UPGRADE-PLAN.md decision B. Opus does the heavier rewriting
// after Sonnet has identified what's wrong.
const STAGE2_MODEL = 'claude-opus-4-7'
const STAGE2_PROVIDER = 'anthropic' as const

// See UPGRADE-PLAN.md decision B. Flagged-only by default (cheaper, focused).
// Change here if you want whole-case as the default UI state.
const DEFAULT_REWRITE_SCOPE: 'flagged-only' | 'whole-case' = 'flagged-only'

// See UPGRADE-PLAN.md task 4 guardrail. Above this many cells, refuse
// "whole-case" runs to stop runaway costs.
const WHOLE_CASE_CELL_CAP = 80

const SYSTEM_PROMPT = `You are a UK clinical guideline expert running STAGE 2 of a two-stage MRCGP SCA case-correction flow.

Stage 1 (Sonnet) has already:
- Read the user's feedback and the full case.
- Searched UK guidelines to verify clinical claims.
- Identified WHICH (recordId, fieldName) cells are affected.

Your job in Stage 2:
- For every TARGET CELL provided below, write a DROP-IN REPLACEMENT.
- Re-check the relevant guideline(s) if useful — you have web search.
- Preserve the original tone, structure and formatting of the cell content.
- Return one rewrite per cell. Never skip a target cell.

═══════════════════════════════════════════════════════════════════════
WHAT "DROP-IN REPLACEMENT" MEANS
═══════════════════════════════════════════════════════════════════════
- suggestedText MUST be the complete new value for the cell, ready for paste.
- Do NOT write meta-instructions ("change X to Y", "remove the bit about Z"…).
- Do NOT describe what to change — perform the change and provide the prose.
- Do NOT truncate. The output must be a full, finished replacement.
- Match the cell's existing style: complete sentences, bullets, markdown, etc.
- Airtable rich text supports **bold**, *italic*, - bullets, 1. lists. \`####\` is NOT rendered as a heading; keep it literal if present.

═══════════════════════════════════════════════════════════════════════
PER-CELL OUTPUT
═══════════════════════════════════════════════════════════════════════
For each target cell return:
- recordId       (verbatim from the case data, never invented)
- fieldName      (exact Airtable field name)
- rowIndex       (0-based position, copied from the data)
- currentText    (verbatim from the case data — used for conflict detection later)
- suggestedText  (the new value — see rules above)
- rationale      (1-2 sentences explaining why this rewrite fixes the issue, with reference to guideline)
- confidence     (high | medium | low)
- sourceUrl      (optional — the guideline URL backing this rewrite)

═══════════════════════════════════════════════════════════════════════
CLINICAL RULES
═══════════════════════════════════════════════════════════════════════
- Only suggest changes supported by current UK guidelines:
  1. NICE CKS (cks.nice.org.uk) — always first
  2. The relevant specialist society (BAD/PCDS for derm, BTS for resp, ESC/BHF for cardio, RCOG/BMS/FSRH for women's health, RCPsych/BAP for mental health, BSG for gastro, BTA for thyroid, entuk.org for ENT, BAUS for urology, BASHH for sexual health, RCPCH for paeds, etc.)
  3. BNF (bnf.nice.org.uk) for any prescribing
- Be specific. Reference doses, thresholds, referral criteria where relevant.
- If a target cell is already correct and doesn't need changing, still emit a rewrite entry where suggestedText equals currentText, rationale explains "no clinical change required", and confidence is "low". Do NOT silently drop cells.`

interface RequestBody {
  feedbackId?: string
  scope?: 'flagged-only' | 'whole-case'
}

export async function POST(req: NextRequest) {
  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const feedbackId = body.feedbackId
  if (!feedbackId) {
    return NextResponse.json({ error: 'Missing feedbackId' }, { status: 400 })
  }

  const scope = body.scope ?? DEFAULT_REWRITE_SCOPE
  if (scope !== 'flagged-only' && scope !== 'whole-case') {
    return NextResponse.json(
      { error: `Invalid scope "${scope}" — must be "flagged-only" or "whole-case"` },
      { status: 400 },
    )
  }

  try {
    const triageRecord = await getTriage(feedbackId)
    if (!triageRecord) {
      return NextResponse.json(
        { error: 'No Stage-1 triage found for this feedback. Run /api/feedback-triage first.' },
        { status: 404 },
      )
    }

    // Always re-fetch fresh case data. The cached snapshot reflects what Stage 1
    // saw — but the user may have edited Airtable since, so Stage 2 must work
    // from the current state to avoid stomping live edits.
    const freshCase = await getCaseDataStructured(triageRecord.caseNumber)
    if (!freshCase || freshCase.records.length === 0) {
      return NextResponse.json(
        { error: `Case ${triageRecord.caseNumber} not found in Airtable on refresh.` },
        { status: 404 },
      )
    }

    // Compare fresh data to snapshot — flag cells that have changed since Stage 1.
    const snapshotByRecord = new Map(
      triageRecord.caseSnapshot.records.map(r => [r.recordId, r.fields]),
    )
    const changedCells: Array<{ recordId: string; fieldName: string }> = []
    for (const rec of freshCase.records) {
      const snap = snapshotByRecord.get(rec.recordId)
      if (!snap) continue
      for (const [fieldName, freshValue] of Object.entries(rec.fields)) {
        if (snap[fieldName] !== undefined && snap[fieldName] !== freshValue) {
          changedCells.push({ recordId: rec.recordId, fieldName })
        }
      }
    }

    // Build the list of TARGET CELLS.
    type Target = { recordId: string; fieldName: string; rowIndex: number; currentText: string }
    const targets: Target[] = []
    const liveFields = new Map<string, Map<string, string>>()
    for (const rec of freshCase.records) {
      liveFields.set(rec.recordId, new Map(Object.entries(rec.fields)))
    }

    if (scope === 'flagged-only') {
      for (const fc of triageRecord.triage.flaggedCells) {
        const recordFields = liveFields.get(fc.recordId)
        if (!recordFields) continue
        const currentText = recordFields.get(fc.fieldName)
        if (currentText == null) continue
        targets.push({
          recordId: fc.recordId,
          fieldName: fc.fieldName,
          rowIndex: fc.rowIndex,
          currentText,
        })
      }
    } else {
      for (const rec of freshCase.records) {
        for (const [fieldName, value] of Object.entries(rec.fields)) {
          if (!value || !value.trim()) continue
          targets.push({
            recordId: rec.recordId,
            fieldName,
            rowIndex: rec.rowIndex,
            currentText: value,
          })
        }
      }
      if (targets.length > WHOLE_CASE_CELL_CAP) {
        return NextResponse.json(
          {
            error:
              `Whole-case rewrite would target ${targets.length} cells, above the ${WHOLE_CASE_CELL_CAP} cap. ` +
              `Switch to "flagged-only" or split the request.`,
            cellCount: targets.length,
            cap: WHOLE_CASE_CELL_CAP,
          },
          { status: 413 },
        )
      }
    }

    if (targets.length === 0) {
      const empty: FeedbackRewriteRecord = {
        feedbackId,
        draftedAt: new Date().toISOString(),
        scope,
        rewrites: [],
        citedUrls: [],
        provider: STAGE2_PROVIDER,
        model: STAGE2_MODEL,
        searchCount: 0,
      }
      await saveRewrites(empty)
      return NextResponse.json({
        feedbackId,
        scope,
        rewrites: [],
        changedSinceTriage: changedCells,
        _meta: {
          provider: STAGE2_PROVIDER,
          model: STAGE2_MODEL,
          searchCount: 0,
          targetCount: 0,
          message: 'No target cells — Stage 1 found nothing to rewrite.',
        },
      })
    }

    const caseText = freshCase.records
      .map(rec => {
        const fieldsText = Object.entries(rec.fields)
          .map(([k, v]) => `  Field "${k}":\n${indent(v, 4)}`)
          .join('\n\n')
        return `RECORD (recordId="${rec.recordId}", rowIndex=${rec.rowIndex}):\n${fieldsText}`
      })
      .join('\n\n---\n\n')

    const targetsText = targets
      .map((t, i) =>
        `[${i + 1}] recordId="${t.recordId}" rowIndex=${t.rowIndex} fieldName="${t.fieldName}"\n` +
        `    currentText:\n${indent(t.currentText, 6)}`,
      )
      .join('\n\n')

    const triageFindingsText = triageRecord.triage.flaggedCells
      .map(fc =>
        `- recordId="${fc.recordId}" fieldName="${fc.fieldName}" (severity: ${fc.severity}): ${fc.issue}`,
      )
      .join('\n') || '(none)'

    const sourcesText = triageRecord.triage.sources
      .map(s => `- ${s.title} (${s.url}): ${s.finding}`)
      .join('\n') || '(none — Stage 1 didn\'t cite any sources)'

    const userPrompt = `CASE NUMBER: ${freshCase.caseNumber}

═══ STAGE 1 (Sonnet) TRIAGE SUMMARY ═══
Verdict: ${triageRecord.triage.verdict} — ${triageRecord.triage.verdictReason}

Summary:
${triageRecord.triage.summary}

Stage 1 findings (cells flagged):
${triageFindingsText}

Stage 1 cited sources:
${sourcesText}

═══ ORIGINAL USER FEEDBACK ═══
(stored under feedbackId="${feedbackId}")

═══ FULL CURRENT CASE CONTENT (re-fetched fresh from Airtable) ═══
${caseText}

═══ TARGET CELLS — write one rewrite per cell below ═══
Scope: ${scope}
${targets.length} cell(s):

${targetsText}

${changedCells.length > 0 ? `
⚠ CELLS THAT CHANGED IN AIRTABLE SINCE STAGE 1 (treat with care):
${changedCells.map(c => `- recordId="${c.recordId}" fieldName="${c.fieldName}"`).join('\n')}
` : ''}

Steps:
1. For each target cell, draft a complete drop-in replacement (suggestedText).
2. Tie every rewrite back to a Stage-1 finding or a guideline you've verified.
3. Match the cell's existing prose style. No editing-instructions.
4. Output one rewrites[] entry per target cell — same order is preferred but not required.`

    // ai-provider auto-bumps max_tokens for sonnet/opus; DRAFT_REWRITES_MAX_TOKENS
    // is reserved for a future explicit override but ignored for now.
    const maxSearches = parseInt(process.env.DRAFT_REWRITES_MAX_SEARCHES ?? '8')

    const result = await callTriageAI(SYSTEM_PROMPT, userPrompt, {
      schema: DRAFT_REWRITES_SCHEMA,
      schemaName: 'submit_rewrites',
      maxSearches,
      modelOverride: STAGE2_MODEL,
      providerOverride: STAGE2_PROVIDER,
    })

    const parsed = result.parsed as { rewrites?: FeedbackRewriteEntry[] }
    const draftedRewrites = Array.isArray(parsed.rewrites) ? parsed.rewrites : []

    // Filter out rewrites that don't reference a real (recordId, fieldName).
    const validTargets = new Set(targets.map(t => `${t.recordId}::${t.fieldName}`))
    const cleanRewrites = draftedRewrites.filter(r =>
      validTargets.has(`${r.recordId}::${r.fieldName}`),
    )

    // Preserve any prior appliedAt timestamps if this is a re-draft.
    const existing = await getRewrites(feedbackId)
    const appliedKey = new Map<string, string>()
    if (existing) {
      for (const r of existing.rewrites) {
        if (r.appliedAt) {
          appliedKey.set(`${r.recordId}::${r.fieldName}`, r.appliedAt)
        }
      }
    }

    const rewrites: FeedbackRewriteEntry[] = cleanRewrites.map(r => {
      const prior = appliedKey.get(`${r.recordId}::${r.fieldName}`)
      return prior ? { ...r, appliedAt: prior } : r
    })

    const record: FeedbackRewriteRecord = {
      feedbackId,
      draftedAt: new Date().toISOString(),
      scope,
      rewrites,
      citedUrls: result.citedUrls,
      provider: result.provider,
      model: result.model,
      searchCount: result.searchCount,
    }
    await saveRewrites(record)

    return NextResponse.json({
      feedbackId,
      scope,
      rewrites,
      changedSinceTriage: changedCells,
      _meta: {
        provider: result.provider,
        model: result.model,
        searchCount: result.searchCount,
        targetCount: targets.length,
        citedUrls: result.citedUrls,
      },
    })
  } catch (err: any) {
    console.error('draft-rewrites error:', err?.message ?? err)
    return NextResponse.json({ error: err?.message ?? 'Unknown error' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const feedbackId = req.nextUrl.searchParams.get('feedbackId')
  if (!feedbackId) {
    return NextResponse.json({ error: 'Missing feedbackId' }, { status: 400 })
  }
  const cached = await getRewrites(feedbackId)
  if (!cached) {
    return NextResponse.json({ cached: false }, { status: 404 })
  }
  return NextResponse.json({
    cached: true,
    feedbackId,
    scope: cached.scope,
    rewrites: cached.rewrites,
    _meta: {
      provider: cached.provider,
      model: cached.model,
      searchCount: cached.searchCount,
      draftedAt: cached.draftedAt,
      citedUrls: cached.citedUrls,
    },
  })
}

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n)
  return s.split('\n').map(line => pad + line).join('\n')
}
