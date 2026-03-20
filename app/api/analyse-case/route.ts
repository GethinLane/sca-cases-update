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

CRITICAL — CASE-SPECIFIC REASONING:
You are given the FULL case content, including the patient's presenting symptoms, history, examination findings, and the management described in the case. You MUST use this specific clinical information when applying guidelines. Do NOT give generic "it depends" answers. Instead:
- Identify the specific patient details from the case (e.g. symptom severity, duration, red flags, comorbidities, age)
- Apply the guideline TO THIS PATIENT and state clearly what the correct management would be for this specific scenario
- If the case describes mild/moderate symptoms and no urgent features, say so and explain why testing before treatment is appropriate here
- If the case describes severe/acute symptoms, say so and explain why immediate treatment is justified here
- Your verdict, summary, suggested field changes and email must all reflect what is correct FOR THIS SPECIFIC PATIENT, not just what the guideline says in general

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
  "caseScenario": "A short paragraph describing the KEY CLINICAL DETAILS from the case that are relevant to the feedback: the patient's presenting symptoms, severity, duration, relevant history, and any features that determine whether the guideline applies in a particular way to THIS patient. This must be specific, not generic.",
  "summary": "A paragraph summarising what the user raised and whether it is correct, partially correct, or incorrect based on evidence APPLIED TO THIS SPECIFIC PATIENT. Do not just state what the guideline says in general — explain how it applies given this patient's presentation, symptom severity, and history.",
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
      "issue": "what is wrong or could be improved, with reference to this patient's specific clinical scenario",
      "suggestedText": "your suggested replacement or addition — this must be clinically appropriate for the specific patient in the case, not a generic guideline statement",
      "confidence": "high" | "medium" | "low"
    }
  ],
  "emailResponse": "A warm, friendly email response to the user — see EMAIL TONE GUIDE below. If no contact requested, write 'No contact requested'."
}

EMAIL TONE GUIDE for the emailResponse field:
- Write like a real person, not a corporate template. Imagine you are a friendly colleague replying to someone who took the time to help improve your work.
- Start with a genuine, warm thank-you that acknowledges the effort they put in — e.g. "Thanks so much for flagging this" or "Really appreciate you taking the time to send this through".
- Do NOT start with "Dear [Name]" or "I hope this email finds you well" or any stiff formality. Use "Hi" or just jump straight into the thank-you.
- Keep it conversational. Use contractions (we've, it's, you're). Short sentences are fine. 
- Explain the outcome clearly but naturally — as if you were telling a colleague over coffee what you found.
- If they were right (fully or partially), genuinely credit them — "You were spot on about..." or "You've raised a really good point here...".
- If they were wrong, be kind and explain why without being patronising — "I can see why you'd think that, but when we checked..." 
- Reference the specific clinical details rather than being vague.
- End warmly — e.g. "Thanks again for helping us keep these cases accurate" or "Do get in touch if you spot anything else". 
- Keep it concise — aim for 4-8 sentences, not an essay.
- Do NOT use phrases like: "I want to assure you", "Please do not hesitate", "We value your contribution", "Rest assured", "We take all feedback seriously", "Your input is invaluable". These sound robotic.
- Sign off casually — "Best wishes" or "Thanks again" followed by "The SCA Revision Team".

IMPORTANT: In the "sources" array, only include sources you actually accessed via web search. Each source MUST have a real URL. Do not list sources from memory — only those you verified by searching.`

  const userPrompt = `CASE NUMBER: ${caseData.caseNumber}

FULL CASE CONTENT:
${caseFieldsText}

---

USER FEEDBACK / ISSUE SUBMITTED:
${feedback.issueSummary}

---

Please:
1. FIRST, read the full case content and identify the specific patient details: presenting symptoms, severity, duration, relevant history, examination findings, and any red flags or acute features. You will need these to apply guidelines correctly.
2. Check the user's feedback against the case content above.
3. Search the web to verify any clinical claims against current UK guidelines (NICE, RCGP, BNF).
4. Apply the guidelines TO THIS SPECIFIC PATIENT — based on their symptom severity and clinical picture, determine what the correct management would be. Do not give a generic "it depends on severity" answer; use the case details to make a specific judgement.
5. Identify which specific fields in the case need changing, if any. Suggested text must be appropriate for this patient's specific scenario.
6. Draft a response email for the user ${feedback.contactEmail ? `(their email: ${feedback.contactEmail})` : '(no contact requested)'}.
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
