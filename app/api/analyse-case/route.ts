// app/api/analyse-case/route.ts
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { feedback, caseData } = await req.json()

  if (!feedback || !caseData) {
    return NextResponse.json({ error: 'Missing feedback or caseData' }, { status: 400 })
  }

  // Build a detailed prompt for Claude
  const caseFieldsText = Object.entries(caseData.fields as Record<string, string>)
    .map(([k, v]) => `### Field: ${k}\n${v}`)
    .join('\n\n---\n\n')

  const systemPrompt = `You are a medical education quality reviewer for MRCGP SCA (Simulated Consultation Assessment) exam cases. 
Your job is to assess user-submitted corrections or issues against the actual case content, verify them against current UK clinical guidelines (NICE, RCGP, BNF), and produce structured recommendations.

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
2. Use web search to verify any clinical claims against current UK guidelines (NICE, RCGP, BNF).
3. Identify which specific fields in the case need changing, if any.
4. For each field that needs changing, provide the current text and your suggested replacement.
5. Draft a response email for the user ${feedback.contactEmail ? `(their email: ${feedback.contactEmail})` : '(no contact requested)'}.`

  try {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
    if (!ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY environment variable is not set' }, { status: 500 })
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })

    const data = await response.json()

    const textBlock = data.content?.find((b: any) => b.type === 'text')
    if (!textBlock) {
      return NextResponse.json({ 
        error: 'No text response from Claude', 
        type: data.type,
        stop_reason: data.stop_reason,
        error_details: data.error,
        content_types: data.content?.map((b: any) => b.type),
        raw: data 
      }, { status: 500 })
    }

    // Strip any accidental markdown fences
    const clean = textBlock.text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)

    return NextResponse.json(parsed)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
