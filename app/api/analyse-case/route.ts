// app/api/analyse-case/route.ts
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { feedback, caseData } = await req.json()

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
Your job is to assess user-submitted corrections or issues against the actual case content, verify them against current UK clinical guidelines (NICE, RCGP, BNF) using web search, and produce structured recommendations.

You must respond ONLY with a valid JSON object — no markdown, no preamble, no explanation outside the JSON.

The JSON must have this exact structure:
{
  "verdict": "valid" | "invalid" | "partial" | "uncertain",
  "verdictReason": "One or two sentence plain-English explanation of your verdict",
  "summary": "A paragraph summarising what the user raised and whether it is correct, partially correct, or incorrect based on evidence",
  "sources": ["list of sources or guidelines you consulted, e.g. NICE CG90, RCGP curriculum topic, BNF section"],
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
}`

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
5. Draft a response email for the user ${feedback.contactEmail ? `(their email: ${feedback.contactEmail})` : '(no contact requested)'}.`

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        tools: [{ type: 'web_search_preview' }],
        instructions,
        input: userPrompt,
      }),
    })

    const data = await response.json()

    console.log('OpenAI status:', response.status)
    console.log('OpenAI error:', data.error)

    if (data.error) {
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

    // Extract web search activity from output blocks
    const searchActivity: { query: string; urls: string[]; niceCksHit: boolean }[] = []
    
    for (const block of data.output ?? []) {
      if (block.type === 'web_search_call') {
        searchActivity.push({
          query: block.action?.query ?? '(unknown query)',
          urls: [],
          niceCksHit: false,
        })
      }
      if (block.type === 'message') {
        // URLs come from url_citation annotations on message content
        const urls: string[] = []
        for (const content of block.content ?? []) {
          for (const annotation of content.annotations ?? []) {
            if (annotation.type === 'url_citation' && annotation.url) {
              urls.push(annotation.url)
            }
          }
        }
        const niceCksHit = urls.some((u: string) =>
          u.includes('cks.nice.org.uk') || u.includes('nice.org.uk')
        )
        if (searchActivity.length > 0) {
          const last = searchActivity[searchActivity.length - 1]
          last.urls = urls
          last.niceCksHit = niceCksHit
        }
      }
    }

    // Strip any accidental markdown fences
    const clean = textOutput.replace(/```json|```/g, '').trim()

    try {
      const parsed = JSON.parse(clean)
      return NextResponse.json({ ...parsed, searchActivity })
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
