// app/upload-case/page.tsx
// Case Uploader — accepts a .md / .docx, parses into sections, lets the user
// map each parsed heading to a real Airtable field on a chosen "Case N"
// table, edit each item inline, preview the rows that will be written, and
// upload either individual sections or the whole case.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import styles from './page.module.css'

interface ParsedSection {
  heading: string
  parentField?: string
  subsection?: string
  items: string[]
}

interface CaseTableSummary {
  id: string
  name: string
  fieldNames: string[]
}

interface UploadResult {
  tableName: string
  created: number
  recordIds: string[]
  errors: string[]
}

const ICE_ROW: Record<string, number> = { ideas: 1, concerns: 2, expectations: 3 }
const MAX_ROWS = 16          // matches lib/case-parser MAX_CASE_ROWS
const SOFT_ROW_WARN = 8      // matches lib/case-parser SOFT_ROW_WARN

export default function CaseUploaderPage() {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [filename, setFilename] = useState<string | null>(null)
  const [fileSize, setFileSize] = useState<number | null>(null)
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [conversionWarnings, setConversionWarnings] = useState<string[]>([])
  const [missingHeadings, setMissingHeadings] = useState<string[]>([])
  const [sections, setSections] = useState<ParsedSection[]>([])

  // heading → real Airtable field name. Empty string means "don't write".
  const [mapping, setMapping] = useState<Record<string, string>>({})
  // heading → array of edited item values (mirrors sections[i].items).
  const [edits, setEdits] = useState<Record<string, string[]>>({})

  const [tables, setTables] = useState<CaseTableSummary[]>([])
  const [tablesError, setTablesError] = useState<string | null>(null)
  const [tablesLoading, setTablesLoading] = useState(true)
  const [selectedTable, setSelectedTable] = useState<string>('')

  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  // Load the case tables once on mount.
  useEffect(() => {
    let cancelled = false
    fetch('/api/case-upload/list-tables')
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        if (data.error) {
          setTablesError(data.error)
        } else {
          setTables(Array.isArray(data.tables) ? data.tables : [])
        }
      })
      .catch(err => { if (!cancelled) setTablesError(String(err)) })
      .finally(() => { if (!cancelled) setTablesLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Resolve the selected table object so we have its field list available.
  // Memoise so the array reference is stable across renders — otherwise the
  // automap useEffect below would loop forever (new array → effect → setState
  // → render → new array …).
  const selectedTableObj = useMemo(
    () => tables.find(t => t.name === selectedTable) ?? null,
    [tables, selectedTable],
  )
  const realFields = useMemo(
    () => selectedTableObj?.fieldNames ?? [],
    [selectedTableObj],
  )

  // Whenever the parsed sections OR the chosen table change, re-run automap
  // so the dropdowns show a sensible default. Don't overwrite a value the
  // user has already changed by hand — track that in `mapping`.
  useEffect(() => {
    if (sections.length === 0 || realFields.length === 0) return
    const fieldsSet = new Set(realFields)
    const lc = new Map(realFields.map(f => [f.toLowerCase(), f]))
    const synonyms: Record<string, string> = {
      'pmh': 'Past Medical History',
      'meds': 'Medications',
    }
    setMapping(prev => {
      let dirty = false
      const next = { ...prev }
      for (const s of sections) {
        if (next[s.heading] !== undefined) continue   // user-edited or already set
        let resolved: string = ''
        if (/^ICE\s*:/i.test(s.heading)) {
          resolved = fieldsSet.has('ICE') ? 'ICE' : (lc.get('ice') ?? '')
        } else if (fieldsSet.has(s.heading)) {
          resolved = s.heading
        } else {
          const ci = lc.get(s.heading.toLowerCase())
          if (ci) resolved = ci
          else {
            const syn = synonyms[s.heading.toLowerCase()]
            if (syn && fieldsSet.has(syn)) resolved = syn
          }
        }
        next[s.heading] = resolved
        dirty = true
      }
      return dirty ? next : prev
    })
  }, [sections, realFields])

  // Seed itemEdits whenever sections arrive. Keep existing edits if heading
  // matches (lets the user re-upload without losing typed changes).
  useEffect(() => {
    setEdits(prev => {
      let dirty = false
      const next = { ...prev }
      for (const s of sections) {
        if (!next[s.heading]) {
          next[s.heading] = [...s.items]
          dirty = true
        }
      }
      return dirty ? next : prev
    })
  }, [sections])

  async function onFileChosen(file: File) {
    setFilename(file.name)
    setFileSize(file.size)
    setParseError(null)
    setConversionWarnings([])
    setMissingHeadings([])
    setSections([])
    setMapping({})
    setEdits({})
    setUploadResult(null)
    setUploadError(null)
    setParsing(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/case-upload/parse', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error ?? `Parse failed (${res.status})`)
      setSections(Array.isArray(data.sections) ? data.sections : [])
      setConversionWarnings(Array.isArray(data.conversionWarnings) ? data.conversionWarnings : [])
      setMissingHeadings(Array.isArray(data.missingCanonicalHeadings) ? data.missingCanonicalHeadings : [])
    } catch (err: any) {
      setParseError(err?.message ?? String(err))
    } finally {
      setParsing(false)
    }
  }

  // Project the current mapping + edits onto Airtable rows.
  const projectedRows = useMemo(() => {
    if (sections.length === 0) return [] as Array<{ rowIndex: number; fields: Record<string, string> }>
    const rows: Record<string, string>[] = Array.from({ length: MAX_ROWS }, () => ({}))
    for (const section of sections) {
      const targetField = mapping[section.heading]
      if (!targetField) continue
      const items = edits[section.heading] ?? section.items
      // ICE: subsection → pinned row
      if (section.parentField === 'ICE' && section.subsection) {
        const row = ICE_ROW[section.subsection.toLowerCase()]
        if (row && items[0]?.trim()) rows[row - 1][targetField] = items[0]
        continue
      }
      items.forEach((v, i) => {
        if (i >= MAX_ROWS) return
        if (v && v.trim()) rows[i][targetField] = v
      })
    }
    return rows
      .map((fields, i) => ({ rowIndex: i + 1, fields }))
      .filter(r => Object.keys(r.fields).length > 0)
  }, [sections, mapping, edits])

  const unmappedCount = useMemo(
    () => sections.filter(s => !mapping[s.heading]).length,
    [sections, mapping],
  )

  async function uploadRows(rows: Array<Record<string, string>>) {
    if (!selectedTable) {
      setUploadError('Pick a target table first.')
      return
    }
    if (rows.length === 0) {
      setUploadError('Nothing to upload — all rows are empty.')
      return
    }
    setUploadError(null)
    setUploadResult(null)
    setUploading(true)
    try {
      const res = await fetch('/api/case-upload/create-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableName: selectedTable, rows }),
      })
      const data = await res.json()
      if (!res.ok || (data.error && data.created === 0)) {
        throw new Error(data.error ?? `Upload failed (${res.status})`)
      }
      setUploadResult({
        tableName: data.tableName,
        created: data.created,
        recordIds: data.recordIds ?? [],
        errors: data.errors ?? [],
      })
    } catch (err: any) {
      setUploadError(err?.message ?? String(err))
    } finally {
      setUploading(false)
    }
  }

  function uploadAll() {
    uploadRows(projectedRows.map(r => r.fields))
  }

  // Upload just one section: its values land in their assigned rows, but
  // every other field on those rows is left out (so we PATCH-style add to
  // existing rows isn't supported — we create new records with only this
  // field). Useful for re-uploads / corrections.
  function uploadSection(heading: string) {
    const section = sections.find(s => s.heading === heading)
    if (!section) return
    const field = mapping[heading]
    if (!field) {
      setUploadError(`No field mapped for "${heading}"`)
      return
    }
    const items = edits[heading] ?? section.items
    const rows: Array<Record<string, string>> = []

    if (section.parentField === 'ICE' && section.subsection) {
      const row = ICE_ROW[section.subsection.toLowerCase()]
      if (row && items[0]?.trim()) {
        rows[row - 1] = { [field]: items[0] }
      }
    } else {
      items.forEach((v, i) => {
        if (v && v.trim()) rows[i] = { [field]: v }
      })
    }
    const nonEmpty = rows.filter(Boolean)
    uploadRows(nonEmpty)
  }

  function removeSection(heading: string) {
    setSections(prev => prev.filter(s => s.heading !== heading))
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <div className={styles.logo}>
              <div className={styles.logoMark}>⚕</div>
              <div>
                <div className={styles.logoText}>SCA Revision Bot</div>
                <div className={styles.logoSub}>Case Uploader</div>
              </div>
            </div>
          </div>
          <nav className={styles.headerNav}>
            <Link href="/" className={styles.navLink}>Feedback Review</Link>
            <Link href="/audit" className={styles.navLink}>Guideline Audit</Link>
            <Link href="/transcripts" className={styles.navLink}>Transcript Insights</Link>
            <Link href="/upload-case" className={`${styles.navLink} ${styles.navLinkActive}`}>Case Uploader</Link>
          </nav>
        </div>
      </header>

      <main className={styles.content}>
        <h1 className={styles.pageTitle}>Upload a new case</h1>
        <p className={styles.pageSubtitle}>
          Drop a <code>.md</code> or <code>.docx</code> SCA case file. We&apos;ll split it
          into sections, map each heading to an Airtable field, and write up to 8 rows
          to the Case table you pick. Item order is preserved — top items go to row 1.
        </p>

        {/* Step 1: file */}
        <div className={styles.card}>
          <div className={styles.cardTitle}>
            <span className={styles.cardTitleNum}>1</span>
            Choose a file
          </div>
          <div
            className={styles.dropZone}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => { e.preventDefault() }}
            onDrop={e => {
              e.preventDefault()
              const f = e.dataTransfer.files?.[0]
              if (f) onFileChosen(f)
            }}
          >
            {parsing ? (
              <><span className={styles.spinner} />Parsing {filename}…</>
            ) : filename ? (
              <>
                <div className={styles.filename}>{filename}</div>
                <div className={styles.fileSize}>{fileSize != null ? `${(fileSize / 1024).toFixed(1)} KB` : ''} — click to replace</div>
              </>
            ) : (
              <>Drag a <code>.md</code> or <code>.docx</code> here, or click to browse</>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            className={styles.fileInput}
            accept=".md,.markdown,.txt,.docx"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) onFileChosen(f)
            }}
          />
          {parseError && <div className={`${styles.flash} ${styles.flashErr}`}>{parseError}</div>}
          {conversionWarnings.length > 0 && (
            <details className={`${styles.flash} ${styles.flashWarn}`}>
              <summary>{conversionWarnings.length} conversion warning(s) from mammoth</summary>
              <ul style={{ margin: '6px 0 0 16px' }}>
                {conversionWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </details>
          )}
          {missingHeadings.length > 0 && (
            <details className={`${styles.flash} ${styles.flashWarn}`} open>
              <summary>
                <strong>{missingHeadings.length}</strong> expected section(s) not found
                in this document — review whether they should be added to the source
                before uploading
              </summary>
              <ul style={{ margin: '6px 0 0 16px' }}>
                {missingHeadings.map(h => <li key={h}>{h}</li>)}
              </ul>
            </details>
          )}
        </div>

        {/* Step 2: target table */}
        <div className={styles.card}>
          <div className={styles.cardTitle}>
            <span className={styles.cardTitleNum}>2</span>
            Pick the destination table
          </div>
          {tablesError ? (
            <div className={`${styles.flash} ${styles.flashErr}`}>{tablesError}</div>
          ) : tablesLoading ? (
            <div className={styles.empty}><span className={styles.spinner} />Loading tables…</div>
          ) : tables.length === 0 ? (
            <div className={styles.empty}>
              No &quot;Case N&quot; tables found in the Cases base. Create one in
              Airtable first (the uploader will refresh next time you open this page).
            </div>
          ) : (
            <div className={styles.row}>
              <span className={styles.label}>Target table</span>
              <select
                className={styles.select}
                value={selectedTable}
                onChange={e => { setSelectedTable(e.target.value); setMapping({}) }}
              >
                <option value="">— pick a Case table —</option>
                {tables.map(t => (
                  <option key={t.id} value={t.name}>{t.name} ({t.fieldNames.length} fields)</option>
                ))}
              </select>
              {selectedTableObj && (
                <span className={styles.fileSize}>
                  Auto-mapping against {selectedTableObj.fieldNames.length} real field names.
                </span>
              )}
            </div>
          )}
        </div>

        {/* Step 3: parsed sections */}
        {sections.length > 0 && (
          <div className={styles.card}>
            <div className={styles.cardTitle}>
              <span className={styles.cardTitleNum}>3</span>
              Review &amp; edit {sections.length} section(s)
              {unmappedCount > 0 && (
                <span className={styles.unmapped} style={{ marginLeft: 8 }}>{unmappedCount} unmapped</span>
              )}
            </div>
            {!selectedTable && (
              <div className={`${styles.flash} ${styles.flashWarn}`}>
                Pick a target table above to see the field-mapping dropdowns.
              </div>
            )}
            {sections.map(section => {
              const isIce = section.parentField === 'ICE'
              const targetField = mapping[section.heading] ?? ''
              const items = edits[section.heading] ?? section.items
              return (
                <div key={section.heading} className={styles.sectionCard}>
                  <div className={styles.sectionHeader}>
                    <div>
                      <div className={styles.sectionHeading}>
                        {section.heading}
                        {isIce && <span className={styles.iceLabel} style={{ marginLeft: 8 }}>ICE row {ICE_ROW[(section.subsection ?? '').toLowerCase()] ?? '?'}</span>}
                        {!targetField && selectedTable && <span className={styles.unmapped} style={{ marginLeft: 8 }}>Unmapped</span>}
                        {items.length > SOFT_ROW_WARN && (
                          <span
                            className={styles.unmapped}
                            style={{ marginLeft: 8, background: '#fef3c7', color: '#92400e', borderColor: '#fde68a' }}
                            title={`This section has ${items.length} items. The stated norm is up to ${SOFT_ROW_WARN}; make sure your "${selectedTable || 'Case'}" table can hold that many rows for this field.`}
                          >
                            {items.length} items
                          </span>
                        )}
                      </div>
                    </div>
                    <div className={styles.sectionMapping}>
                      {selectedTable ? (
                        <>
                          <span>→ field</span>
                          <select
                            className={styles.select}
                            value={targetField}
                            onChange={e => setMapping(m => ({ ...m, [section.heading]: e.target.value }))}
                            style={{ minWidth: 240 }}
                          >
                            <option value="">— don&apos;t write —</option>
                            {realFields.map(f => (
                              <option key={f} value={f}>{f}</option>
                            ))}
                          </select>
                          <button
                            className={styles.ghostBtn}
                            onClick={() => uploadSection(section.heading)}
                            disabled={!targetField || uploading || !selectedTable}
                            title={`Upload just this section to ${selectedTable || '…'}`}
                          >
                            Upload section
                          </button>
                          <button className={styles.dangerBtn} onClick={() => removeSection(section.heading)}>Drop</button>
                        </>
                      ) : (
                        <button className={styles.dangerBtn} onClick={() => removeSection(section.heading)}>Drop</button>
                      )}
                    </div>
                  </div>
                  <div className={styles.itemList}>
                    {items.map((value, i) => {
                      let rowLabel: string
                      if (isIce) rowLabel = `row ${ICE_ROW[(section.subsection ?? '').toLowerCase()] ?? '?'}`
                      else rowLabel = `row ${i + 1}`
                      return (
                        <div key={i} className={styles.itemRow}>
                          <div className={styles.itemRowIndex}>{rowLabel}</div>
                          <textarea
                            className={styles.itemTextarea}
                            value={value}
                            rows={Math.max(1, Math.min(8, value.split('\n').length))}
                            onChange={e => {
                              const next = [...items]
                              next[i] = e.target.value
                              setEdits(s => ({ ...s, [section.heading]: next }))
                            }}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Step 4: preview + upload all */}
        {sections.length > 0 && (
          <div className={styles.card}>
            <div className={styles.cardTitle}>
              <span className={styles.cardTitleNum}>4</span>
              Preview {projectedRows.length} row(s) &amp; upload
            </div>
            {projectedRows.length === 0 ? (
              <div className={styles.empty}>
                Nothing will be written yet — either no fields are mapped or all items are empty.
              </div>
            ) : (
              <div className={styles.preview}>
                {projectedRows.map(row => (
                  <div key={row.rowIndex} className={styles.previewRow}>
                    <div className={styles.previewRowHeader}>Row {row.rowIndex}</div>
                    {Object.entries(row.fields).map(([f, v]) => (
                      <div key={f} className={styles.previewField}>
                        <span className={styles.previewFieldName}>{f}:</span>{' '}
                        {v.length > 240 ? `${v.slice(0, 240)}…` : v}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <div className={styles.row} style={{ marginTop: 12 }}>
              <button
                className={styles.primaryBtn}
                disabled={uploading || !selectedTable || projectedRows.length === 0}
                onClick={uploadAll}
              >
                {uploading ? <><span className={styles.spinner} />Uploading…</> : `Upload all to ${selectedTable || '…'}`}
              </button>
            </div>
            {uploadError && <div className={`${styles.flash} ${styles.flashErr}`}>{uploadError}</div>}
            {uploadResult && (
              <div className={`${styles.flash} ${uploadResult.errors.length === 0 ? styles.flashOk : styles.flashWarn}`}>
                Created {uploadResult.created} row(s) in <strong>{uploadResult.tableName}</strong>.
                {uploadResult.errors.length > 0 && (
                  <>
                    <br />
                    Errors: {uploadResult.errors.join('; ')}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
