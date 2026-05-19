'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import styles from './page.module.css'

interface FeedbackItem {
  feedback: {
    id: string
    caseNumber: string
    issueSummary: string
    contactRegardingOutcome: boolean
    contactEmail: string
  }
  caseData: {
    caseNumber: string
    fields: Record<string, string>
  } | null
}

interface SourceEntry {
  title: string
  url: string
  finding: string
}

interface Verification {
  citedUrls: string[]
  searchQueries: string[]
  niceCksVerified: boolean
  niceVerified: boolean
  niceCksUrls: string[]
  niceUrls: string[]
}

interface FlaggedCell {
  recordId: string
  fieldName: string
  rowIndex: number
  issue: string
  severity: 'high' | 'medium' | 'low'
}

interface TriageResult {
  caseScenario?: string
  summary: string
  sources: SourceEntry[]
  verdict: 'valid' | 'invalid' | 'partial' | 'uncertain'
  verdictReason: string
  flaggedCells: FlaggedCell[]
  emailSubject: string
  emailResponse: string
  _verification?: Verification
  _meta?: { provider: string; model: string; searchCount: number }
}

type MarkDoneState =
  | { status: 'idle' }
  | { status: 'marking' }
  | { status: 'done'; markedAt: string }
  | { status: 'error'; message: string }

interface RewriteEntry {
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

interface RewritesResult {
  feedbackId: string
  scope: 'flagged-only' | 'whole-case'
  rewrites: RewriteEntry[]
  changedSinceTriage?: Array<{ recordId: string; fieldName: string }>
  _meta?: { provider: string; model: string; searchCount: number; targetCount: number; citedUrls?: string[] }
}

type TriageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; data: TriageResult }
  | { status: 'error'; message: string }

type RewritesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; data: RewritesResult }
  | { status: 'error'; message: string }

type ApplyState =
  | { status: 'idle' }
  | { status: 'applying' }
  | { status: 'applied'; appliedAt: string }
  | { status: 'conflict'; actual: string | null; expected: string }
  | { status: 'error'; message: string }

function urlDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

async function readJsonResponse(res: Response): Promise<any> {
  const text = await res.text()
  const contentType = res.headers.get('content-type') ?? ''
  const looksLikeHtml = text.trimStart().startsWith('<')

  if (looksLikeHtml || !contentType.includes('application/json')) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('Session expired — please refresh the page and sign in again.')
    }
    if (res.status === 504 || res.status === 408) {
      throw new Error('The request took too long and the server timed out. Try again, or lower the max searches.')
    }
    if (res.status >= 500) {
      throw new Error(`Server error (${res.status}). The endpoint returned an HTML page instead of JSON. Check the server logs.`)
    }
    throw new Error(`Unexpected non-JSON response (${res.status}). The endpoint may have redirected or crashed.`)
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Server returned malformed JSON (${res.status}).`)
  }
}

function applyKey(recordId: string, fieldName: string) {
  return `${recordId}::${fieldName}`
}

// Build a minimal RFC 5322 .eml that opens as a pre-filled draft when the
// user double-clicks the downloaded file. X-Unsent: 1 is what tells Mail.app
// (and Outlook desktop) to open compose-mode rather than read-mode. Body is
// base64-encoded so any UTF-8 content survives intact; subject is RFC 2047
// Q/B-encoded only if it contains non-ASCII characters.
function buildEmlDraft(to: string, subject: string, body: string): string {
  const CRLF = '\r\n'
  const headers = [
    'From: ',
    `To: ${to}`,
    `Subject: ${encodeEmlSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'X-Unsent: 1',
  ].join(CRLF)
  const encodedBody = wrapBase64(toBase64Utf8(body))
  return headers + CRLF + CRLF + encodedBody + CRLF
}

function encodeEmlSubject(s: string): string {
  // Plain ASCII (printable) → pass through unchanged.
  if (/^[\x20-\x7E]*$/.test(s)) return s
  return `=?utf-8?B?${toBase64Utf8(s)}?=`
}

function toBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function wrapBase64(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? [b64]).join('\r\n')
}

function slugifyForFilename(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export default function Dashboard() {
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [triages, setTriages] = useState<Record<string, TriageState>>({})
  const [rewrites, setRewrites] = useState<Record<string, RewritesState>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copied, setCopied] = useState<Record<string, boolean>>({})
  const [extraContext, setExtraContext] = useState<Record<string, string>>({})
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [scope, setScope] = useState<Record<string, 'flagged-only' | 'whole-case'>>({})
  const [editedText, setEditedText] = useState<Record<string, string>>({})
  const [applyStates, setApplyStates] = useState<Record<string, ApplyState>>({})
  const [editedEmailSubject, setEditedEmailSubject] = useState<Record<string, string>>({})
  const [editedEmailBody, setEditedEmailBody] = useState<Record<string, string>>({})
  const [markDoneStates, setMarkDoneStates] = useState<Record<string, MarkDoneState>>({})

  useEffect(() => {
    fetch('/api/fetch-feedback')
      .then(readJsonResponse)
      .then(d => {
        if (d.error) throw new Error(d.error)
        setItems(d.items)
        if (d.items.length > 0) setSelectedId(d.items[0].feedback.id)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  async function runTriage(item: FeedbackItem) {
    const key = item.feedback.id
    setTriages(t => ({ ...t, [key]: { status: 'loading' } }))
    // Clear stale rewrites — running triage again invalidates the rewrite drafts.
    setRewrites(r => ({ ...r, [key]: { status: 'idle' } }))
    try {
      const res = await fetch('/api/feedback-triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedbackId: key,
          extraContext: extraContext[key] ?? '',
        }),
      })
      const data = await readJsonResponse(res)
      if (data.error) throw new Error(data.error)
      setTriages(t => ({ ...t, [key]: { status: 'done', data } }))
      // Seed editable email subject + body from the AI draft.
      setEditedEmailSubject(s => ({ ...s, [key]: data.emailSubject ?? '' }))
      setEditedEmailBody(b => ({ ...b, [key]: data.emailResponse ?? '' }))
    } catch (e: any) {
      setTriages(t => ({ ...t, [key]: { status: 'error', message: e.message } }))
    }
  }

  async function markFeedbackDone(feedbackId: string) {
    setMarkDoneStates(s => ({ ...s, [feedbackId]: { status: 'marking' } }))
    try {
      const res = await fetch('/api/mark-feedback-done', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedbackId, status: 'Done' }),
      })
      const data = await readJsonResponse(res)
      if (data.error) throw new Error(data.error)
      setMarkDoneStates(s => ({ ...s, [feedbackId]: { status: 'done', markedAt: data.markedAt } }))
      // Remove the row from the list so the dashboard reflects Airtable's filter.
      setItems(prev => prev.filter(i => i.feedback.id !== feedbackId))
      // Pick the next item, if any.
      setSelectedId(prev => {
        if (prev !== feedbackId) return prev
        const remaining = items.filter(i => i.feedback.id !== feedbackId)
        return remaining[0]?.feedback.id ?? null
      })
    } catch (e: any) {
      setMarkDoneStates(s => ({ ...s, [feedbackId]: { status: 'error', message: e.message } }))
    }
  }

  function openInOutlook(_feedbackId: string, to: string, subject: string, body: string) {
    // We can't reliably use mailto: here. On a Mac with Outlook Web registered
    // as the browser's mailto handler, every mailto: URL gets wrapped in an
    // Azure AD OAuth redirect — and Azure AD rejects the request with
    // AADSTS90015 ("Requested query string is too long") whenever the body
    // is longer than a sentence or two. JavaScript can't bypass the
    // browser's mailto handler, so we use a different mechanism entirely:
    // generate an .eml file (RFC 5322 with X-Unsent: 1) and download it.
    // .eml files are handled by the OS-level file association (Mail.app on
    // macOS), which opens them as a pre-filled compose draft regardless of
    // what the browser does with mailto:.
    const eml = buildEmlDraft(to, subject, body)
    const blob = new Blob([eml], { type: 'message/rfc822' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${slugifyForFilename(subject) || 'draft'}.eml`
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function generateRewrites(item: FeedbackItem) {
    const key = item.feedback.id
    const chosenScope = scope[key] ?? 'flagged-only'
    setRewrites(r => ({ ...r, [key]: { status: 'loading' } }))
    try {
      const res = await fetch('/api/draft-rewrites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedbackId: key, scope: chosenScope }),
      })
      const data = await readJsonResponse(res)
      if (data.error) throw new Error(data.error)
      setRewrites(r => ({ ...r, [key]: { status: 'done', data } }))
      // Seed the editable text state from suggestedText for each rewrite.
      const seeded: Record<string, string> = { ...editedText }
      for (const rw of (data.rewrites as RewriteEntry[])) {
        const editKey = `${key}::${applyKey(rw.recordId, rw.fieldName)}`
        if (seeded[editKey] === undefined) {
          seeded[editKey] = rw.suggestedText
        }
      }
      setEditedText(seeded)
    } catch (e: any) {
      setRewrites(r => ({ ...r, [key]: { status: 'error', message: e.message } }))
    }
  }

  async function applyEdit(feedbackId: string, rw: RewriteEntry) {
    const editKey = `${feedbackId}::${applyKey(rw.recordId, rw.fieldName)}`
    const newValue = editedText[editKey] ?? rw.suggestedText
    setApplyStates(s => ({ ...s, [editKey]: { status: 'applying' } }))
    try {
      const res = await fetch('/api/apply-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedbackId,
          recordId: rw.recordId,
          fieldName: rw.fieldName,
          newValue,
        }),
      })
      const data = await readJsonResponse(res)
      if (res.status === 409 && data.conflict) {
        setApplyStates(s => ({
          ...s,
          [editKey]: { status: 'conflict', actual: data.actual ?? null, expected: data.expected ?? '' },
        }))
        return
      }
      if (data.error) throw new Error(data.error)
      setApplyStates(s => ({ ...s, [editKey]: { status: 'applied', appliedAt: data.appliedAt } }))
      // Reflect the appliedAt in the rewrites state too.
      setRewrites(r => {
        const cur = r[feedbackId]
        if (!cur || cur.status !== 'done') return r
        const updated = cur.data.rewrites.map(x =>
          x.recordId === rw.recordId && x.fieldName === rw.fieldName
            ? { ...x, appliedAt: data.appliedAt }
            : x,
        )
        return { ...r, [feedbackId]: { status: 'done', data: { ...cur.data, rewrites: updated } } }
      })
    } catch (e: any) {
      setApplyStates(s => ({ ...s, [editKey]: { status: 'error', message: e.message } }))
    }
  }

  function copyEmail(id: string, text: string) {
    navigator.clipboard.writeText(text)
    setCopied(c => ({ ...c, [id]: true }))
    setTimeout(() => setCopied(c => ({ ...c, [id]: false })), 2000)
  }

  const verdictConfig = {
    valid:     { label: 'Valid correction',  color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
    invalid:   { label: 'Not valid',         color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
    partial:   { label: 'Partially valid',   color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
    uncertain: { label: 'Uncertain',         color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
  }

  const confidenceConfig = {
    high:   { label: 'High confidence',   color: '#15803d', bg: '#dcfce7' },
    medium: { label: 'Medium confidence', color: '#b45309', bg: '#fef3c7' },
    low:    { label: 'Low confidence',    color: '#b91c1c', bg: '#fee2e2' },
  }

  const severityConfig = {
    high:   { label: 'High',   color: '#b91c1c', bg: '#fee2e2' },
    medium: { label: 'Medium', color: '#b45309', bg: '#fef3c7' },
    low:    { label: 'Low',    color: '#3b82c4', bg: '#dbeafe' },
  }

  const selectedItem = items.find(i => i.feedback.id === selectedId) ?? null
  const selectedTriage = selectedId ? (triages[selectedId] ?? { status: 'idle' as const }) : null
  const selectedRewrites = selectedId ? (rewrites[selectedId] ?? { status: 'idle' as const }) : null

  return (
    <div className={styles.root}>

      {/* ── Header ── */}
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <button
              className={styles.menuToggle}
              onClick={() => setSidebarOpen(o => !o)}
              aria-label="Toggle sidebar"
            >
              {sidebarOpen ? '✕' : '☰'}
            </button>
            <div className={styles.logo}>
              <div className={styles.logoMark}>⚕</div>
              <div>
                <div className={styles.logoText}>SCA Revision Bot</div>
                <div className={styles.logoSub}>Case Correction Review Tool</div>
              </div>
            </div>
          </div>
          <nav className={styles.headerNav}>
            <Link href="/" className={`${styles.navLink} ${styles.navLinkActive}`}>Feedback Review</Link>
            <Link href="/audit" className={styles.navLink}>Guideline Audit</Link>
            <Link href="/transcripts" className={styles.navLink}>Transcript Insights</Link>
          </nav>
        </div>
      </header>

      <div className={styles.appShell}>
        {sidebarOpen && (
          <div className={styles.sidebarOverlay} onClick={() => setSidebarOpen(false)} />
        )}

        {/* ── Sidebar ── */}
        <aside className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ''}`}>
          <div className={styles.sidebarHeader}>
            <div className={styles.sidebarTitle}>Pending submissions</div>
            {loading ? (
              <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>Loading…</div>
            ) : (
              <>
                <div className={styles.sidebarCount}>{items.length}</div>
                <div className={styles.sidebarCountLabel}>
                  {items.length === 1 ? 'submission' : 'submissions'}
                </div>
              </>
            )}
          </div>

          <div className={styles.sidebarList}>
            {error && (
              <div style={{ padding: '16px', fontSize: 13, color: '#dc2626' }}>
                Failed to load. Check your environment variables.
              </div>
            )}
            {!loading && !error && items.length === 0 && (
              <div style={{ padding: '24px 20px', fontSize: 13, color: '#999', textAlign: 'center' }}>
                ✓ No pending feedback
              </div>
            )}
            {items.map(item => {
              const isActive = item.feedback.id === selectedId
              const state = triages[item.feedback.id]
              return (
                <div
                  key={item.feedback.id}
                  className={`${styles.sidebarItem} ${isActive ? styles.sidebarItemActive : ''}`}
                  onClick={() => { setSelectedId(item.feedback.id); setSidebarOpen(false) }}
                >
                  <div className={styles.sidebarCaseNum}>
                    Case {item.feedback.caseNumber || '?'}
                    {state?.status === 'done' && ' ✓'}
                    {state?.status === 'loading' && ' …'}
                    {state?.status === 'error' && ' ✗'}
                  </div>
                  <div className={styles.sidebarSnippet}>{item.feedback.issueSummary}</div>
                  <div className={styles.sidebarTags}>
                    {item.feedback.contactRegardingOutcome && (
                      <span className={styles.sidebarTagContact}>Reply needed</span>
                    )}
                    {!item.caseData && (
                      <span className={styles.sidebarTagWarn}>Case not found</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </aside>

        {/* ── Main content ── */}
        <main className={styles.content}>

          {loading && (
            <div className={styles.stateBox}>
              <div className={styles.spinner} />
              <p>Fetching feedback from Airtable…</p>
            </div>
          )}

          {error && (
            <div className={styles.errorBox}>
              <strong>Failed to load feedback</strong>
              <p>{error}</p>
              <p className={styles.hint}>
                Check: AIRTABLE_TOKEN, AIRTABLE_FEEDBACK_BASE_ID, AIRTABLE_CASES_BASE_ID
              </p>
            </div>
          )}

          {!loading && !error && !selectedItem && (
            <div className={styles.emptyState}>
              <div className={styles.emptyStateIcon}>📋</div>
              <div className={styles.emptyStateText}>
                {items.length === 0
                  ? 'No pending submissions — all clear!'
                  : 'Select a submission from the sidebar'}
              </div>
            </div>
          )}

          {!loading && !error && selectedItem && selectedTriage && (
            <>
              {/* Case header */}
              <div className={styles.caseHeader}>
                <div className={styles.caseTitleGroup}>
                  <h1 className={styles.caseTitle}>Case {selectedItem.feedback.caseNumber || '?'}</h1>
                  {selectedItem.feedback.contactRegardingOutcome && (
                    <span className={styles.contactTag}>✉ Reply requested</span>
                  )}
                  {!selectedItem.caseData && (
                    <span className={styles.warnTag}>⚠ Case not found in base</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    className={styles.analyseBtn}
                    onClick={() => runTriage(selectedItem)}
                    disabled={selectedTriage.status === 'loading'}
                  >
                    {selectedTriage.status === 'loading' ? (
                      <><span className={styles.btnSpinner} /> Checking…</>
                    ) : selectedTriage.status === 'done'
                      ? '↺ Re-run triage'
                      : '⚡ Check feedback'}
                  </button>
                  {(() => {
                    const md = markDoneStates[selectedItem.feedback.id] ?? { status: 'idle' as const }
                    return (
                      <button
                        className={styles.analyseBtn}
                        onClick={() => markFeedbackDone(selectedItem.feedback.id)}
                        disabled={md.status === 'marking' || md.status === 'done'}
                        style={{ background: md.status === 'done' ? '#16a34a' : '#475569' }}
                        title="Set the feedback row's Suggestion Status to Done in Airtable"
                      >
                        {md.status === 'marking' ? (
                          <><span className={styles.btnSpinner} /> Marking…</>
                        ) : md.status === 'done'
                          ? '✓ Marked done'
                          : '✓ Mark as done'}
                      </button>
                    )
                  })()}
                </div>
              </div>

              {/* Submitted feedback */}
              <div className={styles.issueBox}>
                <p className={styles.issueLabel}>Submitted feedback</p>
                <p className={styles.issueText}>{selectedItem.feedback.issueSummary}</p>
              </div>

              {/* Context box — before triage */}
              <div className={styles.contextBox}>
                <label className={styles.contextLabel} htmlFor="ctx-before">
                  Additional context{' '}
                  <span className={styles.contextHint}>
                    (optional — add anything that might help the analysis before running it)
                  </span>
                </label>
                <textarea
                  id="ctx-before"
                  className={styles.contextTextarea}
                  placeholder="e.g. The user is referring specifically to the management section. The current guideline changed in 2024..."
                  value={extraContext[selectedItem.feedback.id] ?? ''}
                  onChange={e =>
                    setExtraContext(c => ({ ...c, [selectedItem.feedback.id]: e.target.value }))
                  }
                  rows={3}
                />
              </div>

              {/* Triage error */}
              {selectedTriage.status === 'error' && (
                <div className={styles.inlineError}>
                  Triage failed: {selectedTriage.message}
                </div>
              )}

              {/* Triage results */}
              {selectedTriage.status === 'done' && (
                <>
                  {/* Verdict banner */}
                  {(() => {
                    const vc = verdictConfig[selectedTriage.data.verdict]
                    return (
                      <div
                        className={styles.verdictBanner}
                        style={{ background: vc.bg, borderColor: vc.border }}
                      >
                        <span className={styles.verdictDot} style={{ background: vc.color }} />
                        <strong style={{ color: vc.color }}>{vc.label}</strong>
                        <span className={styles.verdictReason}>{selectedTriage.data.verdictReason}</span>
                      </div>
                    )
                  })()}

                  {/* Case scenario */}
                  {selectedTriage.data.caseScenario && (
                    <div className={styles.section}>
                      <span className={styles.sectionTitle}>Clinical scenario (from case)</span>
                      <p className={styles.caseScenarioText}>{selectedTriage.data.caseScenario}</p>
                    </div>
                  )}

                  {/* Summary */}
                  <div className={styles.section}>
                    <span className={styles.sectionTitle}>Summary</span>
                    <p className={styles.summaryText}>{selectedTriage.data.summary}</p>
                  </div>

                  {/* Sources & Verification */}
                  <div className={styles.section}>
                    <span className={styles.sectionTitle}>Sources & verification</span>

                    {selectedTriage.data._verification && (
                      <div className={styles.verificationBar}>
                        {selectedTriage.data._verification.niceCksVerified ? (
                          <span className={styles.verifiedBadge}>
                            ✅ NICE CKS verified — accessed {selectedTriage.data._verification.niceCksUrls.length} page{selectedTriage.data._verification.niceCksUrls.length !== 1 ? 's' : ''}
                          </span>
                        ) : selectedTriage.data._verification.niceVerified ? (
                          <span className={styles.partialBadge}>
                            ⚠ NICE accessed but not CKS specifically — {selectedTriage.data._verification.niceUrls.length} NICE page{selectedTriage.data._verification.niceUrls.length !== 1 ? 's' : ''}
                          </span>
                        ) : (
                          <span className={styles.unverifiedBadge}>
                            ❌ No NICE pages found in cited URLs — sources may be from model memory
                          </span>
                        )}
                        <span className={styles.urlCountBadge}>
                          {selectedTriage.data._verification.citedUrls.length} URL{selectedTriage.data._verification.citedUrls.length !== 1 ? 's' : ''} cited
                        </span>
                      </div>
                    )}

                    {selectedTriage.data.sources?.length > 0 && (
                      <div className={styles.sourcesGrid}>
                        {selectedTriage.data.sources.map((src, i) => {
                          const domain = urlDomain(src.url)
                          const isNiceCks = domain.includes('cks.nice.org.uk')
                          const isNice = domain.includes('nice.org.uk')
                          return (
                            <div
                              key={i}
                              className={`${styles.sourceCard} ${isNiceCks ? styles.sourceCardNiceCks : isNice ? styles.sourceCardNice : ''}`}
                            >
                              <div className={styles.sourceCardHeader}>
                                <span className={styles.sourceCardTitle}>{src.title}</span>
                                <span className={styles.sourceCardDomain}>{domain}</span>
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
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* Flagged cells (summary list, before rewrites) */}
                  <div className={styles.section}>
                    <span className={styles.sectionTitle}>
                      {selectedTriage.data.flaggedCells?.length > 0
                        ? `Cells flagged for change (${selectedTriage.data.flaggedCells.length})`
                        : 'Cells flagged'}
                    </span>
                    {selectedTriage.data.flaggedCells?.length > 0 ? (
                      <div className={styles.fieldChanges}>
                        {selectedTriage.data.flaggedCells.map((fc, i) => {
                          const sc = severityConfig[fc.severity] ?? severityConfig.medium
                          return (
                            <div key={i} className={styles.fieldCard}>
                              <div className={styles.fieldCardHeader}>
                                <span className={styles.fieldName}>
                                  Record {fc.rowIndex + 1} · {fc.fieldName}
                                </span>
                                <span
                                  className={styles.confidencePill}
                                  style={{ color: sc.color, background: sc.bg }}
                                >
                                  {sc.label} severity
                                </span>
                              </div>
                              <p className={styles.fieldIssue}>{fc.issue}</p>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <p className={styles.noChanges}>
                        No specific cells flagged{selectedTriage.data.verdict === 'invalid' ? ' — feedback assessed as not valid.' : '.'}
                      </p>
                    )}
                  </div>

                  {/* Rewrite generator (Stage 2) — only if there's something to rewrite */}
                  {(selectedTriage.data.verdict === 'valid' || selectedTriage.data.verdict === 'partial') && (
                    <div className={styles.reanalyseBox}>
                      <p className={styles.reanalyseTitle}>Generate per-cell rewrites</p>
                      <p className={styles.reanalyseSubtitle}>
                        Opus 4.7 will draft a drop-in replacement for each cell. You'll review and apply each
                        rewrite individually.
                      </p>
                      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--navy)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
                          Scope
                        </span>
                        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input
                            type="radio"
                            name={`scope-${selectedItem.feedback.id}`}
                            checked={(scope[selectedItem.feedback.id] ?? 'flagged-only') === 'flagged-only'}
                            onChange={() =>
                              setScope(s => ({ ...s, [selectedItem.feedback.id]: 'flagged-only' }))
                            }
                          />
                          Flagged sections only ({selectedTriage.data.flaggedCells?.length ?? 0})
                        </label>
                        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input
                            type="radio"
                            name={`scope-${selectedItem.feedback.id}`}
                            checked={(scope[selectedItem.feedback.id] ?? 'flagged-only') === 'whole-case'}
                            onChange={() =>
                              setScope(s => ({ ...s, [selectedItem.feedback.id]: 'whole-case' }))
                            }
                          />
                          Whole case (costs more)
                        </label>
                      </div>
                      <button
                        className={styles.reanalyseBtn}
                        onClick={() => generateRewrites(selectedItem)}
                        disabled={selectedRewrites?.status === 'loading'}
                      >
                        {selectedRewrites?.status === 'loading' ? (
                          <><span className={styles.btnSpinner} /> Drafting rewrites…</>
                        ) : selectedRewrites?.status === 'done'
                          ? '↺ Re-draft rewrites'
                          : '✎ Generate rewrites'}
                      </button>
                    </div>
                  )}

                  {/* Rewrites error */}
                  {selectedRewrites?.status === 'error' && (
                    <div className={styles.inlineError}>
                      Rewrite draft failed: {selectedRewrites.message}
                    </div>
                  )}

                  {/* Rewrite cards */}
                  {selectedRewrites?.status === 'done' && (
                    <div className={styles.section}>
                      <span className={styles.sectionTitle}>
                        Per-cell rewrites ({selectedRewrites.data.rewrites.length})
                        {selectedRewrites.data.scope === 'whole-case' && ' — whole case'}
                      </span>

                      {(selectedRewrites.data.changedSinceTriage?.length ?? 0) > 0 && (
                        <div className={styles.inlineError} style={{ marginBottom: 12 }}>
                          ⚠ {selectedRewrites.data.changedSinceTriage!.length} cell(s) changed in Airtable
                          between triage and rewrite. Conflict detection will flag stale rewrites at the
                          apply step.
                        </div>
                      )}

                      {selectedRewrites.data.rewrites.length === 0 ? (
                        <p className={styles.noChanges}>
                          No rewrites returned. Nothing to apply.
                        </p>
                      ) : (
                        <div className={styles.fieldChanges}>
                          {selectedRewrites.data.rewrites.map((rw, i) => {
                            const cc = confidenceConfig[rw.confidence] ?? confidenceConfig.medium
                            const editKey = `${selectedItem.feedback.id}::${applyKey(rw.recordId, rw.fieldName)}`
                            const applyState = applyStates[editKey] ?? { status: 'idle' as const }
                            const editedVal = editedText[editKey] ?? rw.suggestedText
                            const isApplied = rw.appliedAt || applyState.status === 'applied'
                            return (
                              <div key={i} className={styles.fieldCard}>
                                <div className={styles.fieldCardHeader}>
                                  <span className={styles.fieldName}>
                                    Record {rw.rowIndex + 1} · {rw.fieldName}
                                  </span>
                                  <span
                                    className={styles.confidencePill}
                                    style={{ color: cc.color, background: cc.bg }}
                                  >
                                    {cc.label}
                                  </span>
                                </div>
                                <p className={styles.fieldIssue}>{rw.rationale}</p>
                                {rw.sourceUrl && (
                                  <p style={{ padding: '0 16px', margin: '4px 0 8px', fontSize: 12 }}>
                                    <a
                                      href={rw.sourceUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{ color: 'var(--accent)' }}
                                    >
                                      {urlDomain(rw.sourceUrl)}
                                    </a>
                                  </p>
                                )}
                                <div className={styles.diffRow}>
                                  <div className={`${styles.diffBox} ${styles.diffBefore}`}>
                                    <span className={styles.diffLabel}>Current</span>
                                    <p>{rw.currentText}</p>
                                  </div>
                                  <div className={styles.diffArrow}>→</div>
                                  <div className={`${styles.diffBox} ${styles.diffAfter}`}>
                                    <span className={styles.diffLabel}>Suggested (editable)</span>
                                    <textarea
                                      className={styles.contextTextarea}
                                      style={{ minHeight: 120, background: '#fff', border: '1px solid #bbf7d0' }}
                                      value={editedVal}
                                      onChange={e =>
                                        setEditedText(t => ({ ...t, [editKey]: e.target.value }))
                                      }
                                      rows={Math.max(4, editedVal.split('\n').length + 1)}
                                      disabled={!!isApplied}
                                    />
                                  </div>
                                </div>
                                <div style={{ padding: '0 16px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                                  <button
                                    className={styles.copyBtn}
                                    onClick={() => applyEdit(selectedItem.feedback.id, rw)}
                                    disabled={applyState.status === 'applying' || !!isApplied}
                                    style={{
                                      background: isApplied ? '#16a34a' : undefined,
                                      cursor: isApplied ? 'default' : undefined,
                                    }}
                                  >
                                    {applyState.status === 'applying'
                                      ? 'Applying…'
                                      : isApplied
                                      ? `✓ Applied${rw.appliedAt ? ' ' + new Date(rw.appliedAt).toLocaleTimeString() : ''}`
                                      : 'Update Airtable'}
                                  </button>
                                  {applyState.status === 'conflict' && (
                                    <div style={{ flexBasis: '100%', marginTop: 6 }} className={styles.inlineError}>
                                      <strong>Conflict — Airtable already changed.</strong>
                                      <div style={{ marginTop: 6, fontSize: 13 }}>
                                        <em>Live value:</em>
                                        <pre style={{
                                          background: '#fff',
                                          padding: 8,
                                          borderRadius: 6,
                                          whiteSpace: 'pre-wrap',
                                          margin: '4px 0',
                                          fontSize: 12,
                                        }}>{applyState.actual ?? '(empty)'}</pre>
                                        <em>What the rewrite expected:</em>
                                        <pre style={{
                                          background: '#fff',
                                          padding: 8,
                                          borderRadius: 6,
                                          whiteSpace: 'pre-wrap',
                                          margin: '4px 0',
                                          fontSize: 12,
                                        }}>{applyState.expected}</pre>
                                        <p style={{ margin: 0 }}>Re-run rewrites to refresh, or apply manually in Airtable.</p>
                                      </div>
                                    </div>
                                  )}
                                  {applyState.status === 'error' && (
                                    <span style={{ color: '#dc2626', fontSize: 13 }}>
                                      {applyState.message}
                                    </span>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Draft email — editable subject + body, with Send via Outlook */}
                  {selectedItem.feedback.contactRegardingOutcome && (() => {
                    const fid = selectedItem.feedback.id
                    const subject = editedEmailSubject[fid] ?? selectedTriage.data.emailSubject ?? ''
                    const body = editedEmailBody[fid] ?? selectedTriage.data.emailResponse ?? ''
                    const to = selectedItem.feedback.contactEmail || ''
                    const noContact = subject.trim() === 'No contact requested'
                    return (
                      <div className={styles.section}>
                        <div className={styles.emailHeader}>
                          <span className={styles.sectionTitle}>Draft email response</span>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <button
                              className={styles.copyBtn}
                              onClick={() => copyEmail(fid, `Subject: ${subject}\n\n${body}`)}
                            >
                              {copied[fid] ? '✓ Copied' : 'Copy'}
                            </button>
                            <button
                              className={styles.copyBtn}
                              style={{ background: '#0078d4' }}
                              onClick={() => openInOutlook(fid, to, subject, body)}
                              disabled={!to || noContact}
                              title={
                                !to
                                  ? 'No contact email on the feedback row'
                                  : noContact
                                  ? 'Submitter did not request contact'
                                  : `Download a draft .eml addressed to ${to} — opens in your default mail app (Mail.app on macOS, Outlook desktop on Windows)`
                              }
                            >
                              ✉ Open draft in Mail
                            </button>
                          </div>
                        </div>
                        {to && <p className={styles.emailTo}>To: {to}</p>}
                        <div style={{ marginBottom: 10 }}>
                          <label
                            style={{
                              display: 'block',
                              fontSize: 11,
                              fontWeight: 700,
                              color: 'var(--text-muted)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.8px',
                              marginBottom: 4,
                            }}
                          >
                            Subject
                          </label>
                          <input
                            type="text"
                            className={styles.contextTextarea}
                            value={subject}
                            onChange={e =>
                              setEditedEmailSubject(s => ({ ...s, [fid]: e.target.value }))
                            }
                            style={{ fontFamily: 'inherit', fontSize: 14 }}
                          />
                        </div>
                        <div>
                          <label
                            style={{
                              display: 'block',
                              fontSize: 11,
                              fontWeight: 700,
                              color: 'var(--text-muted)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.8px',
                              marginBottom: 4,
                            }}
                          >
                            Body
                          </label>
                          <textarea
                            className={styles.contextTextarea}
                            value={body}
                            onChange={e =>
                              setEditedEmailBody(b => ({ ...b, [fid]: e.target.value }))
                            }
                            rows={Math.max(8, body.split('\n').length + 1)}
                            style={{ minHeight: 180, fontSize: 14, lineHeight: 1.6 }}
                          />
                        </div>
                        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                          Edit the subject and body above. "Open draft in Mail"
                          downloads a small <code>.eml</code> file — double-click it
                          (or your browser may open it automatically) to launch your
                          default mail app with the recipient, subject and body all
                          pre-filled as a draft. On macOS that's Mail.app; on Windows
                          it's Outlook desktop. Pick{' '}
                          <strong>info@scarevision.co.uk</strong> as the From address
                          before sending so it goes from the right mailbox.
                          <br />
                          <br />
                          We use <code>.eml</code> rather than a <code>mailto:</code>{' '}
                          link because Outlook Web's mailto handler runs every link
                          through an Azure AD auth redirect and rejects anything
                          longer than a sentence ("AADSTS90015: query string too
                          long"). <code>.eml</code> sidesteps the browser handler
                          entirely.
                        </p>
                      </div>
                    )
                  })()}

                  {/* Re-run triage box */}
                  <div className={styles.reanalyseBox}>
                    <p className={styles.reanalyseTitle}>Refine this triage</p>
                    <p className={styles.reanalyseSubtitle}>
                      Add extra context or corrections and re-run the triage. This invalidates any
                      drafted rewrites.
                    </p>
                    <textarea
                      className={styles.contextTextarea}
                      placeholder="e.g. Please also check the BNF for drug interactions. The user is specifically referring to the 2025 NICE update..."
                      value={extraContext[selectedItem.feedback.id] ?? ''}
                      onChange={e =>
                        setExtraContext(c => ({ ...c, [selectedItem.feedback.id]: e.target.value }))
                      }
                      rows={3}
                    />
                    <button
                      className={styles.reanalyseBtn}
                      onClick={() => runTriage(selectedItem)}
                      disabled={triages[selectedItem.feedback.id]?.status === 'loading'}
                    >
                      {triages[selectedItem.feedback.id]?.status === 'loading' ? (
                        <><span className={styles.btnSpinner} /> Re-running…</>
                      ) : '↺ Re-run triage with this context'}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
