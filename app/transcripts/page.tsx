'use client'

import { Fragment, useMemo, useState } from 'react'
import Link from 'next/link'
import styles from './page.module.css'

interface TranscriptRow {
  id: string
  caseId: string
  transcript: string
  createdAt: string
}

interface Finding {
  caseId: string
  question: string
  frequency: number
  clinicallyRelevant: 'Yes' | 'No'
  relevanceReason: string
  suggestedAddition: string
  exampleQuotes: string
  botResponse: string
  deflectionType: 'patient_should_have_known' | 'meta_relevance'
  // Server-attached for diagnostics; may be missing on legacy responses.
  transcriptIndices?: number[]
}

type RunState =
  | { phase: 'idle' }
  | { phase: 'fetching' }
  | { phase: 'analysing'; batchIndex: number; totalBatches: number; collected: number }
  | { phase: 'done'; totalTranscripts: number; totalBatches: number }
  | { phase: 'error'; message: string }

const BATCH_SIZE = 50

function todayISO(): string {
  const now = new Date()
  // Use local date — the user is picking "a day" in their calendar
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

async function readJson(res: Response) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Server returned non-JSON (${res.status}): ${text.slice(0, 200)}`)
  }
}

/**
 * Merge findings that point at the same case + (loosely) the same question.
 * Different batches may surface the same question across different transcripts —
 * we want a single row per (caseId, normalised question) with summed frequency.
 */
function mergeFindings(all: Finding[]): Finding[] {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

  const map = new Map<string, Finding>()
  for (const f of all) {
    const key = `${f.caseId}::${norm(f.question)}`
    const existing = map.get(key)
    if (!existing) {
      map.set(key, { ...f })
    } else {
      existing.frequency += f.frequency
      // Keep the most generous suggestion / reason if existing was empty
      if (!existing.suggestedAddition && f.suggestedAddition) {
        existing.suggestedAddition = f.suggestedAddition
      }
      if (existing.exampleQuotes && f.exampleQuotes && existing.exampleQuotes !== f.exampleQuotes) {
        existing.exampleQuotes = `${existing.exampleQuotes} | ${f.exampleQuotes}`.slice(0, 1000)
      } else if (!existing.exampleQuotes) {
        existing.exampleQuotes = f.exampleQuotes
      }
      if (existing.botResponse && f.botResponse && existing.botResponse !== f.botResponse) {
        existing.botResponse = `${existing.botResponse} | ${f.botResponse}`.slice(0, 1000)
      } else if (!existing.botResponse) {
        existing.botResponse = f.botResponse
      }
      // If either batch said Yes, lean Yes — the case author can still un-tick it
      if (f.clinicallyRelevant === 'Yes') existing.clinicallyRelevant = 'Yes'
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.clinicallyRelevant !== b.clinicallyRelevant) {
      return a.clinicallyRelevant === 'Yes' ? -1 : 1
    }
    if (b.frequency !== a.frequency) return b.frequency - a.frequency
    return (parseInt(a.caseId) || 0) - (parseInt(b.caseId) || 0)
  })
}

export default function TranscriptsPage() {
  const [date, setDate] = useState<string>(todayISO())
  const [runState, setRunState] = useState<RunState>({ phase: 'idle' })
  const [findings, setFindings] = useState<Finding[]>([])
  const [selected, setSelected] = useState<Record<number, boolean>>({})
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const [onlyRelevant, setOnlyRelevant] = useState(true)
  const [saveResult, setSaveResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const visibleFindings = useMemo(
    () => (onlyRelevant ? findings.filter(f => f.clinicallyRelevant === 'Yes') : findings),
    [findings, onlyRelevant],
  )

  const selectedCount = Object.values(selected).filter(Boolean).length

  async function runAnalysis() {
    setSaveResult(null)
    setFindings([])
    setSelected({})
    setExpanded({})

    // 1. Fetch transcripts for the day
    setRunState({ phase: 'fetching' })
    let transcripts: TranscriptRow[]
    try {
      const res = await fetch(`/api/transcripts/fetch?date=${encodeURIComponent(date)}`)
      const data = await readJson(res)
      if (data.error) throw new Error(data.error)
      transcripts = data.transcripts ?? []
    } catch (err: any) {
      setRunState({ phase: 'error', message: `Fetch failed: ${err.message}` })
      return
    }

    if (transcripts.length === 0) {
      setRunState({ phase: 'done', totalTranscripts: 0, totalBatches: 0 })
      return
    }

    // 2. Analyse in batches of 50
    const totalBatches = Math.ceil(transcripts.length / BATCH_SIZE)
    const all: Finding[] = []

    for (let i = 0; i < transcripts.length; i += BATCH_SIZE) {
      const batchIndex = Math.floor(i / BATCH_SIZE) + 1
      setRunState({
        phase: 'analysing',
        batchIndex,
        totalBatches,
        collected: all.length,
      })

      const batch = transcripts.slice(i, i + BATCH_SIZE)
      try {
        const res = await fetch('/api/transcripts/analyse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcripts: batch }),
        })
        const data = await readJson(res)
        if (data.error) throw new Error(data.error)
        if (Array.isArray(data.findings)) all.push(...data.findings)
      } catch (err: any) {
        setRunState({
          phase: 'error',
          message: `Batch ${batchIndex}/${totalBatches} failed: ${err.message}`,
        })
        return
      }
    }

    const merged = mergeFindings(all)
    setFindings(merged)
    // Pre-tick clinically relevant ones so the common case ("save these") is one click away
    const initialSelected: Record<number, boolean> = {}
    merged.forEach((f, i) => {
      if (f.clinicallyRelevant === 'Yes') initialSelected[i] = true
    })
    setSelected(initialSelected)
    setRunState({ phase: 'done', totalTranscripts: transcripts.length, totalBatches })
  }

  async function saveSelected() {
    const toSave = findings
      .map((f, i) => ({ f, i }))
      .filter(({ i }) => selected[i])
      .map(({ f }) => ({
        caseId: f.caseId,
        question: f.question,
        frequency: f.frequency,
        clinicallyRelevant: f.clinicallyRelevant,
        relevanceReason: f.relevanceReason,
        suggestedAddition: f.suggestedAddition,
        exampleQuotes: f.exampleQuotes,
        botResponse: f.botResponse,
        deflectionType: f.deflectionType,
        analysedDate: date,
      }))

    console.log('[transcripts] save clicked', {
      totalFindings: findings.length,
      selectedKeys: Object.keys(selected).filter(k => selected[Number(k)]),
      toSaveCount: toSave.length,
    })

    if (toSave.length === 0) {
      setSaveResult({ kind: 'err', text: 'Nothing selected — tick at least one row before saving.' })
      return
    }
    setSaving(true)
    setSaveResult(null)
    try {
      const res = await fetch('/api/transcripts/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findings: toSave }),
      })
      const rawText = await res.text()
      console.log('[transcripts] save response', { status: res.status, body: rawText.slice(0, 500) })

      let data: any = {}
      try { data = JSON.parse(rawText) } catch { /* non-JSON response handled below */ }

      if (res.ok) {
        setSaveResult({
          kind: 'ok',
          text: `Saved ${data.created ?? '?'} row${data.created === 1 ? '' : 's'} to Missing Case Details.`,
        })
      } else if (res.status === 207) {
        const firstErr = data.errors?.[0] ?? 'unknown'
        setSaveResult({
          kind: 'err',
          text: `Airtable rejected the write — saved ${data.created ?? 0}, failed ${data.errors?.length ?? 0} batch(es). First error from Airtable: ${firstErr}`,
        })
      } else if (res.status === 401 || res.status === 403) {
        setSaveResult({
          kind: 'err',
          text: 'Save failed: session expired. Refresh the page and sign in again.',
        })
      } else {
        const detail = data.error ?? rawText.slice(0, 300) ?? `HTTP ${res.status}`
        throw new Error(`HTTP ${res.status} — ${detail}`)
      }
    } catch (err: any) {
      console.error('[transcripts] save error', err)
      setSaveResult({ kind: 'err', text: `Save failed: ${err.message}` })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.root}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <div className={styles.logo}>
              <div className={styles.logoMark}>⚕</div>
              <div>
                <div className={styles.logoText}>SCA Revision Bot</div>
                <div className={styles.logoSub}>Transcript Insights</div>
              </div>
            </div>
          </div>
          <nav className={styles.headerNav}>
            <Link href="/" className={styles.navLink}>Feedback Review</Link>
            <Link href="/audit" className={styles.navLink}>Guideline Audit</Link>
            <Link href="/transcripts" className={`${styles.navLink} ${styles.navLinkActive}`}>Transcript Insights</Link>
          </nav>
        </div>
      </header>

      <main className={styles.content}>
        <h1 className={styles.pageTitle}>Transcript Insights</h1>
        <p className={styles.pageSubtitle}>
          Scan a day's bot conversations for recurring questions where the bot couldn't answer, then flag the clinically relevant ones for case authors.
        </p>

        {/* Controls */}
        <div className={styles.controlCard}>
          <div className={styles.controlRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel} htmlFor="date">Date</label>
              <input
                id="date"
                type="date"
                className={styles.fieldInput}
                value={date}
                onChange={e => setDate(e.target.value)}
                disabled={runState.phase === 'fetching' || runState.phase === 'analysing'}
              />
            </div>
            <button
              className={styles.primaryBtn}
              onClick={runAnalysis}
              disabled={runState.phase === 'fetching' || runState.phase === 'analysing'}
            >
              {runState.phase === 'fetching' || runState.phase === 'analysing' ? (
                <><span className={styles.spinner} /> Running…</>
              ) : (
                <>⚡ Run analysis</>
              )}
            </button>
          </div>

          {runState.phase === 'fetching' && (
            <div className={styles.progressBox}>
              Fetching transcripts for {date}…
            </div>
          )}

          {runState.phase === 'analysing' && (
            <div className={styles.progressBox}>
              Analysing batch {runState.batchIndex} of {runState.totalBatches}
              {' '}({runState.collected} findings so far)
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${(runState.batchIndex / runState.totalBatches) * 100}%` }}
                />
              </div>
            </div>
          )}

          {runState.phase === 'done' && (
            <div className={styles.progressBox}>
              Done — scanned {runState.totalTranscripts} transcript{runState.totalTranscripts === 1 ? '' : 's'} across {runState.totalBatches} batch{runState.totalBatches === 1 ? '' : 'es'}.
            </div>
          )}

          {runState.phase === 'error' && (
            <div className={styles.errorBox}>{runState.message}</div>
          )}
        </div>

        {saveResult && (
          <div className={saveResult.kind === 'ok' ? styles.successBox : styles.errorBox}>
            {saveResult.text}
          </div>
        )}

        {/* Findings */}
        {runState.phase === 'done' && findings.length === 0 && (
          <div className={styles.findingsCard}>
            <div className={styles.emptyState}>
              No bot deflections found for {date} — nothing to review.
            </div>
          </div>
        )}

        {findings.length > 0 && (
          <>
            <div className={styles.filterBar}>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={onlyRelevant}
                  onChange={e => setOnlyRelevant(e.target.checked)}
                />
                Show only clinically relevant
              </label>
              <span className={styles.filterLabel}>
                {visibleFindings.length} of {findings.length} shown
              </span>
            </div>

            <div className={styles.findingsCard}>
              <div className={styles.findingsHeader}>
                <span className={styles.findingsTitle}>Findings for {date}</span>
                <span className={styles.findingsCount}>{visibleFindings.length} questions</span>
              </div>

              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.colCheckbox}>
                        <input
                          type="checkbox"
                          checked={visibleFindings.length > 0 && visibleFindings.every((_, vi) => {
                            const i = findings.indexOf(visibleFindings[vi])
                            return selected[i]
                          })}
                          onChange={e => {
                            const next = { ...selected }
                            for (const vf of visibleFindings) {
                              const i = findings.indexOf(vf)
                              next[i] = e.target.checked
                            }
                            setSelected(next)
                          }}
                        />
                      </th>
                      <th className={styles.colCase}>Case</th>
                      <th>Question</th>
                      <th className={styles.colFreq} title="Times asked & deflected within this case">Freq (in case)</th>
                      <th className={styles.colRel}>Clinically rel.</th>
                      <th>Suggested addition</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleFindings.map((f) => {
                      const i = findings.indexOf(f)
                      const isExpanded = expanded[i]
                      return (
                        <Fragment key={i}>
                          <tr>
                            <td className={styles.colCheckbox}>
                              <input
                                type="checkbox"
                                checked={!!selected[i]}
                                onChange={e => setSelected(s => ({ ...s, [i]: e.target.checked }))}
                              />
                            </td>
                            <td className={styles.colCase}>{f.caseId || '—'}</td>
                            <td>
                              {f.question}
                              <div>
                                <button
                                  className={styles.expandBtn}
                                  onClick={() => setExpanded(x => ({ ...x, [i]: !x[i] }))}
                                >
                                  {isExpanded ? '▾ Hide details' : '▸ Show reason & quotes'}
                                </button>
                              </div>
                            </td>
                            <td className={styles.colFreq}>{f.frequency}</td>
                            <td className={styles.colRel}>
                              <span className={f.clinicallyRelevant === 'Yes' ? styles.relYes : styles.relNo}>
                                {f.clinicallyRelevant === 'Yes' ? '✓ Yes' : 'No'}
                              </span>
                            </td>
                            <td>{f.suggestedAddition || <span style={{ color: '#999' }}>—</span>}</td>
                          </tr>
                          {isExpanded && (
                            <tr className={styles.expandedRow}>
                              <td colSpan={6}>
                                <div className={styles.expandedLabel}>Deflection type</div>
                                <p className={styles.expandedBody}>
                                  {f.deflectionType === 'patient_should_have_known'
                                    ? 'Patient should have known (case content gap)'
                                    : f.deflectionType === 'meta_relevance'
                                      ? 'Meta / relevance challenge (out-of-character)'
                                      : '—'}
                                </p>
                                <div className={styles.expandedLabel}>Relevance reason</div>
                                <p className={styles.expandedBody}>{f.relevanceReason || '—'}</p>
                                <div className={styles.expandedLabel}>Candidate quotes (the question asked)</div>
                                <p className={styles.expandedBody}>{f.exampleQuotes || '—'}</p>
                                <div className={styles.expandedLabel}>Bot's deflection</div>
                                <p className={styles.expandedBody}>{f.botResponse || '—'}</p>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {saveResult && (
                <div
                  className={saveResult.kind === 'ok' ? styles.successBox : styles.errorBox}
                  style={{ margin: '0 20px', borderRadius: 0 }}
                >
                  {saveResult.text}
                </div>
              )}
              <div className={styles.footerBar}>
                <span className={styles.selectedCount}>
                  {selectedCount === 0
                    ? 'Tick rows above to enable save'
                    : `${selectedCount} selected`}
                </span>
                <button
                  className={styles.primaryBtn}
                  onClick={saveSelected}
                  disabled={saving || selectedCount === 0}
                  title={selectedCount === 0 ? 'Select at least one row' : ''}
                >
                  {saving ? (
                    <><span className={styles.spinner} /> Saving…</>
                  ) : (
                    <>💾 Save {selectedCount > 0 ? `${selectedCount} ` : ''}to Missing Case Details</>
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
