'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import styles from './page.module.css'

interface TriageResult {
  caseNumber: string
  status: 'up-to-date' | 'review-needed' | 'outdated' | 'error' | 'pending'
  summary: string
  searchCount: number
  citedUrls: string[]
  provider: string
  model: string
  timestamp: string
  assessmentSnippet?: string
  managementSnippet?: string
  reviewedAt?: string
}

interface Stats {
  total: number
  upToDate: number
  reviewNeeded: number
  outdated: number
  errors: number
  pending: number
  reviewed: number
  totalSearches: number
}

interface TriageMetadata {
  lastScanStarted: string | null
  lastScanCompleted: string | null
  totalCases: number
  casesScanned: number
  scanInProgress: boolean
}

interface FullAnalysisFieldChange {
  fieldName: string
  currentText: string
  issue: string
  suggestedText: string
  confidence: 'high' | 'medium' | 'low'
  source: string
}

interface FullAnalysisSource {
  title: string
  url: string
  finding: string
}

interface FullAnalysisResult {
  verdict: 'up-to-date' | 'changes-needed'
  summary: string
  fieldChanges: FullAnalysisFieldChange[]
  sources: FullAnalysisSource[]
  caseNumber: string
  fieldNames: string
  triageStatus: string
  triageSummary: string
  citedUrls: string[]
  searchCount: number
  provider: string
  model: string
}

type FullAnalysisState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; data: FullAnalysisResult }
  | { status: 'error'; message: string }

type FilterStatus = 'all' | 'outdated' | 'review-needed' | 'up-to-date' | 'reviewed' | 'pending' | 'error'

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  'up-to-date': { label: 'Up to date', className: 'statusUpToDate' },
  'review-needed': { label: 'Review needed', className: 'statusReviewNeeded' },
  'outdated': { label: 'Outdated', className: 'statusOutdated' },
  'error': { label: 'Error', className: 'statusError' },
  'pending': { label: 'Pending', className: 'statusPending' },
}

// 6 per minute = 1 every 10 seconds (start-to-start)
const SCAN_INTERVAL_MS = 60000

export default function AuditDashboard() {
  const [results, setResults] = useState<TriageResult[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [metadata, setMetadata] = useState<TriageMetadata | null>(null)
  const [provider, setProvider] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterStatus>('all')
  const [selectedCase, setSelectedCase] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0 })
  const [syncing, setSyncing] = useState(false)
  const [scanFrom, setScanFrom] = useState('1')
  const [scanTo, setScanTo] = useState('10')
  const [scanPaused, setScanPaused] = useState(false)
  const [nextScanIn, setNextScanIn] = useState<number | null>(null)

  // Full analysis state
  const [fullAnalysis, setFullAnalysis] = useState<Record<string, FullAnalysisState>>({})
  const [fullAnalysisContext, setFullAnalysisContext] = useState<Record<string, string>>({})
  const [copiedField, setCopiedField] = useState<string | null>(null)

  // Refs for pause/stop control (must survive re-renders)
  const scanAbortRef = useRef(false)
  const scanPauseRef = useRef(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/triage-status')
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setResults(data.results ?? [])
      setStats(data.stats ?? null)
      setMetadata(data.metadata ?? null)
      setProvider(data.provider ?? '')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  // Countdown timer for next scan
  useEffect(() => {
    if (nextScanIn === null || nextScanIn <= 0) return
    const interval = setInterval(() => {
      setNextScanIn(prev => (prev !== null && prev > 0) ? prev - 1 : null)
    }, 1000)
    return () => clearInterval(interval)
  }, [nextScanIn])

  async function syncCases() {
    setSyncing(true)
    setError(null)
    const chunkSize = 50
    const totalCases = 355
    let start = 1

    try {
      while (start <= totalCases) {
        setScanProgress({ current: start - 1, total: totalCases })
        const res = await fetch(`/api/sync-cases?start=${start}&limit=${chunkSize}`, {
          method: 'POST',
        })
        const data = await res.json()
        if (data.error) throw new Error(data.error)
        start += chunkSize
        await new Promise(r => setTimeout(r, 2000))
      }
      setScanProgress({ current: totalCases, total: totalCases })
      await fetchStatus()
    } catch (e: any) {
      setError(`Sync failed at case ${start}: ${e.message}`)
    } finally {
      setSyncing(false)
    }
  }

  async function runScan() {
    const from = parseInt(scanFrom) || 1
    const to = parseInt(scanTo) || 355

    if (from > to || from < 1) {
      setError('Invalid range — "from" must be less than "to"')
      return
    }

    setScanning(true)
    setScanPaused(false)
    scanAbortRef.current = false
    scanPauseRef.current = false
    setError(null)

    const targets: string[] = []
    for (let i = from; i <= to; i++) {
      targets.push(String(i))
    }

    setScanProgress({ current: 0, total: targets.length })

    for (let i = 0; i < targets.length; i++) {
      // Check for stop
      if (scanAbortRef.current) break

      // Check for pause — wait until resumed
      while (scanPauseRef.current) {
        await new Promise(r => setTimeout(r, 500))
        if (scanAbortRef.current) break
      }
      if (scanAbortRef.current) break

      const startTime = Date.now()

      setResults(prev =>
        prev.map(r => r.caseNumber === targets[i]
          ? { ...r, status: 'pending' as const, summary: 'Scanning…' }
          : r
        )
      )

      try {
        const res = await fetch('/api/triage-case', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ caseNumber: targets[i], batchMode: true }),
        })
        const data = await res.json()
        setResults(prev =>
          prev.map(r => r.caseNumber === targets[i] ? { ...r, ...data } : r)
        )
      } catch { /* continue on error */ }

      setScanProgress({ current: i + 1, total: targets.length })

      // Wait for the remainder of the 10-second interval (start-to-start)
      if (i < targets.length - 1) {
        const elapsed = Date.now() - startTime
        const waitTime = Math.max(0, SCAN_INTERVAL_MS - elapsed)

        if (waitTime > 0) {
          // Show countdown
          setNextScanIn(Math.ceil(waitTime / 1000))

          // Wait in 1-second increments so we can respond to pause/stop
          const waitEnd = Date.now() + waitTime
          while (Date.now() < waitEnd) {
            if (scanAbortRef.current) break
            while (scanPauseRef.current) {
              setNextScanIn(null)
              await new Promise(r => setTimeout(r, 500))
              if (scanAbortRef.current) break
            }
            if (scanAbortRef.current) break
            const remaining = Math.ceil((waitEnd - Date.now()) / 1000)
            if (remaining > 0) setNextScanIn(remaining)
            await new Promise(r => setTimeout(r, 1000))
          }
          setNextScanIn(null)
        }
      }
    }

    setScanning(false)
    setScanPaused(false)
    setNextScanIn(null)
    await fetchStatus()
  }

  function stopScan() {
    scanAbortRef.current = true
    scanPauseRef.current = false
    setScanPaused(false)
    setNextScanIn(null)
  }

  function togglePause() {
    if (scanPauseRef.current) {
      scanPauseRef.current = false
      setScanPaused(false)
    } else {
      scanPauseRef.current = true
      setScanPaused(true)
      setNextScanIn(null)
    }
  }

  async function triageSingle(caseNumber: string) {
    setResults(prev =>
      prev.map(r => r.caseNumber === caseNumber ? { ...r, status: 'pending' as const, summary: 'Scanning…' } : r)
    )
    try {
      const res = await fetch('/api/triage-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseNumber, batchMode: false }),
      })
      const data = await res.json()
      setResults(prev =>
        prev.map(r => r.caseNumber === caseNumber ? { ...r, ...data } : r)
      )
    } catch (e: any) {
      setResults(prev =>
        prev.map(r => r.caseNumber === caseNumber ? { ...r, status: 'error' as const, summary: e.message } : r)
      )
    }
  }

  async function runFullAnalysis(caseNumber: string) {
    setFullAnalysis(prev => ({ ...prev, [caseNumber]: { status: 'loading' } }))
    try {
      const res = await fetch('/api/full-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseNumber,
          extraContext: fullAnalysisContext[caseNumber] ?? '',
        }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setFullAnalysis(prev => ({ ...prev, [caseNumber]: { status: 'done', data } }))
    } catch (e: any) {
      setFullAnalysis(prev => ({ ...prev, [caseNumber]: { status: 'error', message: e.message } }))
    }
  }

  async function markReviewed(caseNumber: string) {
    try {
      const res = await fetch('/api/mark-reviewed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseNumber }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setResults(prev =>
        prev.map(r => r.caseNumber === caseNumber
          ? { ...r, reviewedAt: data.reviewedAt }
          : r
        )
      )
    } catch (e: any) {
      setError(`Failed to mark reviewed: ${e.message}`)
    }
  }

  const filtered = (() => {
    if (filter === 'all') return results
    if (filter === 'reviewed') return results.filter(r => !!r.reviewedAt)
    return results.filter(r => r.status === filter)
  })()

  // Sort: unreviewed cases first (by severity), then reviewed cases by oldest review first
  const statusOrder: Record<string, number> = { 'outdated': 0, 'review-needed': 1, 'pending': 2, 'error': 3, 'up-to-date': 4 }
  const sorted = [...filtered].sort((a, b) => {
    // Unreviewed always before reviewed
    const aReviewed = a.reviewedAt ? 1 : 0
    const bReviewed = b.reviewedAt ? 1 : 0
    if (aReviewed !== bReviewed) return aReviewed - bReviewed

    // Within reviewed: oldest review first (needs re-review soonest)
    if (a.reviewedAt && b.reviewedAt) {
      return new Date(a.reviewedAt).getTime() - new Date(b.reviewedAt).getTime()
    }

    // Within unreviewed: by status severity
    return (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5)
  })

  const selectedResult = results.find(r => r.caseNumber === selectedCase)
  const selectedFullAnalysis = selectedCase ? fullAnalysis[selectedCase] : undefined

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  const rangeCount = Math.max(0, (parseInt(scanTo) || 0) - (parseInt(scanFrom) || 0) + 1)
  const estimatedMinutes = Math.ceil(rangeCount / 6)

  return (
    <div className={styles.root}>
      {/* ── Header ── */}
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.logo}>
            <div className={styles.logoMark}>⚕</div>
            <div>
              <div className={styles.logoText}>SCA Revision Bot</div>
              <div className={styles.logoSub}>Guideline Audit Dashboard</div>
            </div>
          </div>
          <nav className={styles.headerNav}>
            <Link href="/" className={styles.navLink}>Feedback Review</Link>
            <Link href="/audit" className={`${styles.navLink} ${styles.navLinkActive}`}>Guideline Audit</Link>
          </nav>
        </div>
      </header>

      <div className={styles.appShell}>
        {/* ── Sidebar ── */}
        <aside className={styles.sidebar}>
          {/* Stats header */}
          <div className={styles.sidebarHeader}>
            <div className={styles.sidebarTitle}>Case audit</div>
            {stats && (
              <div className={styles.sidebarStats}>
                <span className={styles.statGreen}>{stats.upToDate} ok</span>
                <span className={styles.statAmber}>{stats.reviewNeeded} review</span>
                <span className={styles.statRed}>{stats.outdated} outdated</span>
                <span className={styles.statBlue}>{stats.reviewed} reviewed</span>
                <span className={styles.statMuted}>{stats.pending} pending</span>
              </div>
            )}
          </div>

          {/* Controls */}
          <div className={styles.sidebarControls}>
            <button
              className={`${styles.scanBtn} ${styles.scanBtnSecondary}`}
              onClick={syncCases}
              disabled={syncing || scanning}
            >
              {syncing ? <><span className={styles.btnSpinner} /> Syncing…</> : '⬇ Sync Airtable'}
            </button>

            <div className={styles.scanRange}>
              <input
                type="number"
                className={styles.scanRangeInput}
                value={scanFrom}
                onChange={e => setScanFrom(e.target.value)}
                min={1} max={355}
                disabled={scanning}
              />
              <span className={styles.scanRangeTo}>to</span>
              <input
                type="number"
                className={styles.scanRangeInput}
                value={scanTo}
                onChange={e => setScanTo(e.target.value)}
                min={1} max={355}
                disabled={scanning}
              />
              {!scanning ? (
                <button
                  className={styles.scanBtn}
                  onClick={runScan}
                  disabled={syncing || results.length === 0}
                  title={`~${estimatedMinutes} min at 6/min`}
                >
                  ⚡ Scan ({rangeCount})
                </button>
              ) : (
                <>
                  <button
                    className={styles.scanBtn}
                    onClick={togglePause}
                    style={{ background: scanPaused ? '#16a34a' : '#d97706' }}
                  >
                    {scanPaused ? '▶ Resume' : '⏸ Pause'}
                  </button>
                  <button
                    className={styles.scanBtn}
                    onClick={stopScan}
                    style={{ background: '#dc2626' }}
                  >
                    ■ Stop
                  </button>
                </>
              )}
            </div>

            {/* Rate & ETA info */}
            {scanning && (
              <div style={{ fontSize: 11, color: '#6b7a99', lineHeight: 1.4 }}>
                Rate: 6 cases/min
                {scanProgress.total > 0 && (
                  <> · ~{Math.ceil((scanProgress.total - scanProgress.current) / 6)} min remaining</>
                )}
                {nextScanIn !== null && nextScanIn > 0 && (
                  <> · Next in {nextScanIn}s</>
                )}
                {scanPaused && <> · <strong style={{ color: '#d97706' }}>PAUSED</strong></>}
              </div>
            )}
          </div>

          {/* Progress bar */}
          {(scanning || syncing) && scanProgress.total > 0 && (
            <div className={styles.sidebarProgress}>
              <div className={styles.progressWrap}>
                <div
                  className={styles.progressBar}
                  style={{ width: `${(scanProgress.current / scanProgress.total) * 100}%` }}
                />
              </div>
              <div className={styles.progressText}>
                {syncing ? `Syncing ${scanProgress.current}/${scanProgress.total}` : `Scanning ${scanProgress.current}/${scanProgress.total}`}
              </div>
            </div>
          )}

          {/* Filter bar */}
          <div className={styles.filterBar}>
            {(['all', 'outdated', 'review-needed', 'up-to-date', 'reviewed', 'pending', 'error'] as FilterStatus[]).map(f => {
              const count = f === 'all'
                ? results.length
                : f === 'reviewed'
                  ? results.filter(r => !!r.reviewedAt).length
                  : results.filter(r => r.status === f).length
              if (count === 0 && f !== 'all') return null
              const labels: Record<string, string> = {
                'all': 'All', 'outdated': 'Outdated', 'review-needed': 'Review',
                'up-to-date': 'OK', 'reviewed': 'Reviewed', 'pending': 'Pending', 'error': 'Errors',
              }
              return (
                <button
                  key={f}
                  className={`${styles.filterBtn} ${filter === f ? styles.filterBtnActive : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {labels[f]} <span className={styles.filterCount}>{count}</span>
                </button>
              )
            })}
          </div>

          {/* Case list */}
          <div className={styles.sidebarList}>
            {loading && (
              <div style={{ padding: '24px 20px', textAlign: 'center' }}>
                <div className={styles.spinner} />
                <p style={{ fontSize: 13, color: '#888' }}>Loading…</p>
              </div>
            )}
            {!loading && results.length === 0 && (
              <div style={{ padding: '24px 20px', fontSize: 13, color: '#999', textAlign: 'center' }}>
                Click "Sync Airtable" to load cases
              </div>
            )}
            {sorted.map(r => {
              const sc = STATUS_CONFIG[r.status] ?? STATUS_CONFIG['pending']
              const isActive = r.caseNumber === selectedCase
              return (
                <div
                  key={r.caseNumber}
                  className={`${styles.sidebarItem} ${isActive ? styles.sidebarItemActive : ''}`}
                  onClick={() => setSelectedCase(r.caseNumber)}
                >
                  <div className={styles.sidebarItemRow}>
                    <span className={styles.sidebarCaseNum}>Case {r.caseNumber}</span>
                    <span className={`${styles.statusBadgeSm} ${styles[sc.className]}`}>{sc.label}</span>
                    {r.reviewedAt && (
                      <span className={styles.reviewedTimestamp}>✓ {timeAgo(r.reviewedAt)}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </aside>

        {/* ── Main content ── */}
        <main className={styles.content}>
          {error && (
            <div className={styles.errorBox}>
              <strong>Error</strong>
              <p>{error}</p>
            </div>
          )}

          {!selectedResult && !error && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>📋</div>
              <div className={styles.emptyText}>
                {results.length === 0
                  ? 'No cases loaded — click "Sync Airtable" to start'
                  : 'Select a case from the sidebar to view details'}
              </div>
            </div>
          )}

          {selectedResult && (
            <>
              {/* Case header */}
              <div className={styles.caseHeader}>
                <div className={styles.caseTitleGroup}>
                  <h1 className={styles.caseTitle}>Case {selectedResult.caseNumber}</h1>
                  {(() => {
                    const sc = STATUS_CONFIG[selectedResult.status]
                    return <span className={`${styles.statusBadge} ${styles[sc.className]}`}>{sc.label}</span>
                  })()}
                  {selectedResult.reviewedAt && (
                    <span className={styles.reviewedBadge}>✓ Reviewed {timeAgo(selectedResult.reviewedAt)}</span>
                  )}
                </div>
                <div className={styles.caseActions}>
                  <button
                    className={selectedResult.reviewedAt ? styles.reviewBtnDone : styles.reviewBtn}
                    onClick={() => markReviewed(selectedResult.caseNumber)}
                  >
                    {selectedResult.reviewedAt ? `✓ Reviewed ${timeAgo(selectedResult.reviewedAt)}` : '✓ Mark reviewed'}
                  </button>
                  <button
                    className={styles.analyseBtn}
                    onClick={() => triageSingle(selectedResult.caseNumber)}
                    disabled={scanning}
                  >
                    {selectedResult.status === 'pending' && selectedResult.summary === 'Scanning…'
                      ? <><span className={styles.btnSpinner} /> Scanning…</>
                      : '↺ Re-triage'}
                  </button>
                  <button
                    className={styles.analyseBtnSecondary}
                    onClick={() => runFullAnalysis(selectedResult.caseNumber)}
                    disabled={selectedFullAnalysis?.status === 'loading'}
                  >
                    {selectedFullAnalysis?.status === 'loading'
                      ? <><span className={styles.btnSpinner} /> Analysing…</>
                      : '⚡ Full analysis'}
                  </button>
                </div>
              </div>

              {/* Verdict */}
              {selectedResult.status !== 'pending' && (
                <div className={styles.section}>
                  <span className={styles.sectionTitle}>Triage verdict</span>
                  <div className={styles.verdictText}
                    dangerouslySetInnerHTML={{
                      __html: selectedResult.summary
                        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                    }}
                  />
                </div>
              )}

              {/* Assessment */}
              {selectedResult.assessmentSnippet && (
                <div className={styles.section}>
                  <span className={styles.sectionTitle}>Assessment</span>
                  <pre className={styles.caseText}>{selectedResult.assessmentSnippet}</pre>
                </div>
              )}

              {/* Management */}
              {selectedResult.managementSnippet && (
                <div className={styles.section}>
                  <span className={styles.sectionTitle}>Management</span>
                  <pre className={styles.caseText}>{selectedResult.managementSnippet}</pre>
                </div>
              )}

              {/* Sources */}
              {selectedResult.citedUrls.length > 0 && (
                <div className={styles.section}>
                  <span className={styles.sectionTitle}>Sources accessed</span>
                  <ul className={styles.sourceList}>
                    {selectedResult.citedUrls.map((url, i) => (
                      <li key={i}>
                        <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Meta */}
              <div className={styles.metaBar}>
                <span>Provider: <strong>{selectedResult.provider || '—'}</strong></span>
                <span>Model: <strong>{selectedResult.model || '—'}</strong></span>
                <span>Searches: <strong>{selectedResult.searchCount}</strong></span>
                <span>Scanned: <strong>{selectedResult.timestamp && selectedResult.status !== 'pending' ? timeAgo(selectedResult.timestamp) : '—'}</strong></span>
              </div>

              {/* ══════════════════════════════════════════════════
                  FULL ANALYSIS SECTION
                  ══════════════════════════════════════════════════ */}

              <div className={styles.fullAnalysisSection}>
                <div className={styles.fullAnalysisHeader}>
                  <h2 className={styles.fullAnalysisTitle}>Full Analysis</h2>
                  <p className={styles.fullAnalysisSubtitle}>
                    Reviews every field in the case — Assessment, Management, Marking Criteria, History, Explanation and more — against current UK guidelines
                  </p>
                </div>

                {/* Extra context input */}
                <div className={styles.fullAnalysisContextBox}>
                  <label className={styles.fullAnalysisContextLabel}>
                    Additional context{' '}
                    <span className={styles.fullAnalysisContextHint}>
                      (optional — e.g. "focus on the prescribing section", "check the 2025 NICE update")
                    </span>
                  </label>
                  <textarea
                    className={styles.fullAnalysisTextarea}
                    placeholder="Add any context to guide the analysis..."
                    value={fullAnalysisContext[selectedResult.caseNumber] ?? ''}
                    onChange={e =>
                      setFullAnalysisContext(c => ({ ...c, [selectedResult.caseNumber]: e.target.value }))
                    }
                    rows={2}
                  />
                  <button
                    className={styles.fullAnalysisRunBtn}
                    onClick={() => runFullAnalysis(selectedResult.caseNumber)}
                    disabled={selectedFullAnalysis?.status === 'loading'}
                  >
                    {selectedFullAnalysis?.status === 'loading'
                      ? <><span className={styles.btnSpinner} /> Running full analysis…</>
                      : selectedFullAnalysis?.status === 'done'
                        ? '↺ Re-run full analysis'
                        : '⚡ Run full analysis'}
                  </button>
                </div>

                {/* Full analysis error */}
                {selectedFullAnalysis?.status === 'error' && (
                  <div className={styles.errorBox} style={{ marginTop: 16 }}>
                    <strong>Full analysis failed</strong>
                    <p>{selectedFullAnalysis.message}</p>
                  </div>
                )}

                {/* Full analysis results */}
                {selectedFullAnalysis?.status === 'done' && (
                  <div className={styles.fullAnalysisResults}>
                    {/* Verdict banner */}
                    <div
                      className={styles.fullAnalysisVerdictBanner}
                      style={{
                        background: selectedFullAnalysis.data.verdict === 'up-to-date' ? '#f0fdf4' : '#fffbeb',
                        borderColor: selectedFullAnalysis.data.verdict === 'up-to-date' ? '#bbf7d0' : '#fde68a',
                      }}
                    >
                      <span
                        className={styles.fullAnalysisVerdictDot}
                        style={{
                          background: selectedFullAnalysis.data.verdict === 'up-to-date' ? '#16a34a' : '#d97706',
                        }}
                      />
                      <strong style={{
                        color: selectedFullAnalysis.data.verdict === 'up-to-date' ? '#16a34a' : '#d97706',
                      }}>
                        {selectedFullAnalysis.data.verdict === 'up-to-date' ? 'Up to date' : 'Changes needed'}
                      </strong>
                      <span className={styles.fullAnalysisVerdictText}>
                        {selectedFullAnalysis.data.summary}
                      </span>
                    </div>

                    {/* Fields reviewed */}
                    {selectedFullAnalysis.data.fieldNames && (
                      <div className={styles.fieldsReviewedBar}>
                        <span className={styles.fieldsReviewedLabel}>Fields reviewed:</span>
                        <span className={styles.fieldsReviewedList}>{selectedFullAnalysis.data.fieldNames}</span>
                      </div>
                    )}

                    {/* Field changes — diff cards */}
                    <div className={styles.section}>
                      <span className={styles.sectionTitle}>
                        {selectedFullAnalysis.data.fieldChanges?.length > 0
                          ? `Suggested changes (${selectedFullAnalysis.data.fieldChanges.length})`
                          : 'Field changes'}
                      </span>
                      {selectedFullAnalysis.data.fieldChanges?.length > 0 ? (
                        <div className={styles.fieldChanges}>
                          {selectedFullAnalysis.data.fieldChanges.map((fc, i) => {
                            const confColors: Record<string, { color: string; bg: string }> = {
                              high:   { color: '#15803d', bg: '#dcfce7' },
                              medium: { color: '#b45309', bg: '#fef3c7' },
                              low:    { color: '#b91c1c', bg: '#fee2e2' },
                            }
                            const cc = confColors[fc.confidence] ?? confColors.medium
                            return (
                              <div key={i} className={styles.fieldCard}>
                                <div className={styles.fieldCardHeader}>
                                  <span className={styles.fieldName}>{fc.fieldName}</span>
                                  <span
                                    className={styles.confidencePill}
                                    style={{ color: cc.color, background: cc.bg }}
                                  >
                                    {fc.confidence} confidence
                                  </span>
                                </div>
                                <p className={styles.fieldIssue}>{fc.issue}</p>
                                {fc.source && (
                                  <a
                                    href={fc.source}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={styles.fieldSource}
                                  >
                                    {fc.source}
                                  </a>
                                )}
                                <div className={styles.diffRow}>
                                  <div className={`${styles.diffBox} ${styles.diffBefore}`}>
                                    <div className={styles.diffLabelRow}>
                                      <span className={styles.diffLabel}>Current</span>
                                      <button
                                        className={styles.diffCopyBtn}
                                        onClick={() => {
                                          navigator.clipboard.writeText(fc.currentText)
                                          setCopiedField(`current-${i}`)
                                          setTimeout(() => setCopiedField(null), 1500)
                                        }}
                                      >
                                        {copiedField === `current-${i}` ? '✓' : 'Copy'}
                                      </button>
                                    </div>
                                    <p className={styles.diffText}>{fc.currentText}</p>
                                  </div>
                                  <div className={styles.diffArrow}>→</div>
                                  <div className={`${styles.diffBox} ${styles.diffAfter}`}>
                                    <div className={styles.diffLabelRow}>
                                      <span className={styles.diffLabel}>Suggested</span>
                                      <button
                                        className={styles.diffCopyBtn}
                                        onClick={() => {
                                          navigator.clipboard.writeText(fc.suggestedText)
                                          setCopiedField(`suggested-${i}`)
                                          setTimeout(() => setCopiedField(null), 1500)
                                        }}
                                      >
                                        {copiedField === `suggested-${i}` ? '✓' : 'Copy'}
                                      </button>
                                    </div>
                                    <p className={styles.diffText}>{fc.suggestedText}</p>
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <p className={styles.noChanges}>No specific field changes recommended — case appears up to date.</p>
                      )}
                    </div>

                    {/* Sources */}
                    {selectedFullAnalysis.data.sources?.length > 0 && (
                      <div className={styles.section}>
                        <span className={styles.sectionTitle}>Sources verified</span>
                        <div className={styles.sourcesGrid}>
                          {selectedFullAnalysis.data.sources.map((src, i) => (
                            <div key={i} className={styles.sourceCard}>
                              <div className={styles.sourceCardHeader}>
                                <span className={styles.sourceCardTitle}>{src.title}</span>
                              </div>
                              <a
                                href={src.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={styles.sourceCardUrl}
                              >
                                {src.url}
                              </a>
                              {src.finding && (
                                <p className={styles.sourceCardFinding}>{src.finding}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* All cited URLs */}
                    {selectedFullAnalysis.data.citedUrls?.length > 0 && (
                      <div className={styles.section}>
                        <span className={styles.sectionTitle}>All URLs accessed ({selectedFullAnalysis.data.citedUrls.length})</span>
                        <ul className={styles.sourceList}>
                          {selectedFullAnalysis.data.citedUrls.map((url, i) => (
                            <li key={i}>
                              <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Meta */}
                    <div className={styles.metaBar}>
                      <span>Provider: <strong>{selectedFullAnalysis.data.provider || '—'}</strong></span>
                      <span>Model: <strong>{selectedFullAnalysis.data.model || '—'}</strong></span>
                      <span>Searches: <strong>{selectedFullAnalysis.data.searchCount}</strong></span>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  )
}
