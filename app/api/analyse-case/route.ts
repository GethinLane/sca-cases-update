// app/api/analyse-case/route.ts
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { feedback, caseData, extraContext } = await req.json()

  if (!feedback || !caseData) {
    return NextResponse.json({ error: 'Missing feedback or caseData' }, { status: 400 })
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY
  if (!OPENAI_API_KEY) {
    return NextResponse.json({ error: 'OPENAI_API_KEY environment variable is not set' }, { status: 500 })
  }

  // Build case content, capped to avoid token limits
  const caseFieldsText = Object.entries(caseData.fields as Record<string, string>)
    .map(([k, v]) => `### Field: ${k}\n${v}`)
    .join('\n\n---\n\n')
    .slice(0, 30000)

  const instructions = `You are a medical education quality reviewer for MRCGP SCA (Simulated Consultation Assessment) exam cases.
Your job is to assess user-submitted corrections or issues against the actual case content, verify them against current UK clinical guidelines using web search, and produce structured recommendations.

When verifying any clinical claim, you MUST search the following sources as relevant to the topic:
- NICE CKS (cks.nice.org.uk) — always search this first, it is the primary UK primary care reference
- NICE guidelines (nice.org.uk/guidance) — for relevant NG/TA/QS guidelines
- RCGP resources (rcgp.org.uk) — for GP-specific guidance
- BNF (bnf.nice.org.uk) — for prescribing and drug information
- British Association of Dermatology (bad.org.uk) — for any dermatology topics
- British Menopause Society (thebms.org.uk) — for any menopause or HRT topics
- Royal College of Obstetricians and Gynaecologists (rcog.org.uk) — for any obstetric or gynaecological topics
- British Thoracic Society (brit-thoracic.org.uk) — for any respiratory topics
- SIGN guidelines (sign.ac.uk) — for any topics with SIGN guidance
- British Heart Foundation / British Cardiovascular Society — for any cardiology topics
- British Thyroid Association (british-thyroid-association.org) — for any thyroid topics

Always include at least one explicit search targeting cks.nice.org.uk. Only search the specialist society guidelines that are relevant to the clinical topic being reviewed.

You must respond ONLY with a valid JSON object — no markdown, no preamble, no explanation outside the JSON.

The JSON must have this exact structure:
{
  "verdict": "valid" | "invalid" | "partial" | "uncertain",
  "verdictReason": "One or two sentence plain-English explanation of your verdict",
  "summary": "A paragraph summarising what the user raised and whether it is correct, partially correct, or incorrect based on evidence",
  "sources": [
    {
      "title": "Short descriptive title, e.g. NICE CKS: Peripheral arterial disease",
      "url": "The actual URL you accessed, e.g. https://cks.nice.org.uk/topics/peripheral-arterial-disease/",
      "finding": "One sentence summary of what this source confirmed or contradicted"
    }
  ],
  "fieldChanges": [
    {
      "fieldName": "exact field name from the case",
      "currentText": "the current text in that field (shortened if very long)",
      "issue": "what is wrong or could be improved",
      "suggestedText": "your suggested replacement or addition",
      "confidence": "high" | "medium" | "low"
    }
  ],
  "emailResponse": "A polite, professional email response to the user. If no contact requested, write 'No contact requested'. Address them generically as 'Thank you for your feedback'. Explain the outcome clearly."
}

IMPORTANT: In the "sources" array, only include sources you actually accessed via web search. Each source MUST have a real URL. Do not list sources from memory — only those you verified by searching.`

  const userPrompt = `CASE NUMBER: ${caseData.caseNumber}

FULL CASE CONTENT:
${caseFieldsText}

---

USER FEEDBACK / ISSUE SUBMITTED:
${feedback.issueSummary}

---

Please:
1. Check the user's feedback against the case content above.
2. Search the web to verify any clinical claims against current UK guidelines (NICE, RCGP, BNF).
3. Identify which specific fields in the case need changing, if any.
4. For each field that needs changing, provide the current text and your suggested replacement.
5. Draft a response email for the user ${feedback.contactEmail ? `(their email: ${feedback.contactEmail})` : '(no contact requested)'}.
${extraContext ? `
---

ADDITIONAL CONTEXT FROM REVIEWER:
${extraContext}

Please take this additional context into account in your analysis.` : ''}`

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        tools: [{ type: 'web_search_preview' }],
        instructions,
        input: userPrompt,
      }),
    })

    const data = await response.json()

    console.log('OpenAI status:', response.status)
    if (data.error) {
      console.log('OpenAI error:', data.error)
      return NextResponse.json({
        error: `OpenAI API error: ${data.error.code} — ${data.error.message}`
      }, { status: 500 })
    }

    // Extract text output from the responses API
    const textOutput = data.output?.find((o: any) => o.type === 'message')
      ?.content?.find((c: any) => c.type === 'output_text')?.text

    if (!textOutput) {
      return NextResponse.json({
        error: 'No text response from OpenAI',
        output_types: data.output?.map((o: any) => o.type),
      }, { status: 500 })
    }

    // ── Extract ALL cited URLs from annotations across the entire output ──
    // These are the URLs the model actually accessed during web search.
    const citedUrls: string[] = []
    for (const block of data.output ?? []) {
      if (block.type === 'message') {
        for (const content of block.content ?? []) {
          for (const annotation of content.annotations ?? []) {
            if (annotation.type === 'url_citation' && annotation.url) {
              if (!citedUrls.includes(annotation.url)) {
                citedUrls.push(annotation.url)
              }
            }
          }
        }
      }
    }

    // ── Extract search queries (best-effort from web_search_call blocks) ──
    const searchQueries: string[] = []
    for (const block of data.output ?? []) {
      if (block.type === 'web_search_call') {
        // Try multiple known locations for the query string
        const query =
          (typeof block.query === 'string' && block.query) ||
          (typeof block.action?.query === 'string' && block.action.query) ||
          (typeof block.input === 'string' && block.input) ||
          null

        if (query) {
          searchQueries.push(query)
        }
        // If we couldn't find a readable query, skip it rather than showing raw JSON
      }
    }

    // ── Determine NICE CKS verification status from actual cited URLs ──
    const niceCksUrls = citedUrls.filter(u => u.includes('cks.nice.org.uk'))
    const niceUrls = citedUrls.filter(u => u.includes('nice.org.uk'))
    const niceCksVerified = niceCksUrls.length > 0
    const niceVerified = niceUrls.length > 0

    // Strip any accidental markdown fences
    const clean = textOutput.replace(/```json|```/g, '').trim()

    try {
      const parsed = JSON.parse(clean)
      return NextResponse.json({
        ...parsed,
        // Append verified URL data so the frontend knows what was actually accessed
        _verification: {
          citedUrls,
          searchQueries,
          niceCksVerified,
          niceVerified,
          niceCksUrls,
          niceUrls,
        },
      })
    } catch {
      return NextResponse.json({
        error: 'Response was not valid JSON',
        raw_text: clean.slice(0, 500)
      }, { status: 500 })
    }

  } catch (err: any) {
    console.log('Fetch error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
