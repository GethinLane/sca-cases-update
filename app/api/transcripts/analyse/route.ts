// app/api/transcripts/analyse/route.ts
// Sends one batch of bot/patient transcripts to GPT-5.4-mini and asks it to
// flag recurring questions where the bot deflected (e.g. "I don't know",
// "not relevant here", "I'm not sure"), classify clinical relevance, and
// suggest what the case author should add.
//
// The client calls this once per batch (up to 50 transcripts each) so it can
// show progress and so we stay well under the 60s function timeout per call.

import { NextRequest, NextResponse } from 'next/server'
import { TRANSCRIPT_ANALYSIS_SCHEMA } from '@/lib/schemas'

export const maxDuration = 300

const SYSTEM_PROMPT = `You are a quality reviewer for an MRCGP SCA medical-roleplay bot. The bot plays patients in simulated clinical consultations.

You are given a batch of transcripts from real candidate practice sessions. In each transcript, a candidate (the doctor) asks the bot (the patient) questions. Sometimes the bot can't answer — it says things like:
  • "I'm not sure"
  • "I don't know"
  • "Is that relevant here?"
  • "I don't have that information"
  • "That's not in my notes"
  • or hedges/deflects in similar ways.

Your job is to find every recurring patient question that triggered such a deflection, and decide whether the missing piece of information was clinically relevant for the case.

DETECTION
- Read every bot turn for hedges, deflections, refusals, or admissions of not knowing.
- For each one, identify the question the candidate had just asked.
- Normalise to a clean canonical phrasing (e.g. "Does she take her inhaler regularly?" — not the verbatim quote).
- Group equivalent paraphrases of the same question across transcripts into ONE finding and set frequency = number of transcripts it appeared in.

CLINICAL RELEVANCE (this is the important judgement call)
- Yes  → knowing the answer would plausibly change history-taking, diagnosis, differential, risk assessment, management, or safety-netting for this case.
- No   → genuinely irrelevant chit-chat (clothing colour, hobbies, what the dog is called).

For Yes findings, also write a "suggestedAddition" — a copy/paste-ready sentence the case author can drop into the case content to plug the gap. Be specific to the case; don't write meta-instructions like "add information about adherence" — write the actual sentence.

For No findings, leave suggestedAddition as an empty string.

ONE FINDING PER QUESTION-PER-CASE. If the same question recurs across cases, emit one finding per case (with the relevant caseId), not a merged super-finding.

OUTPUT
Return a single JSON object matching the schema. If nothing in this batch triggered any bot hedges, return { "findings": [] }.`

async function callOpenAI(systemPrompt: string, userPrompt: string) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set')

  const model = process.env.TRANSCRIPTS_OPENAI_MODEL
    ?? process.env.TRIAGE_OPENAI_MODEL
    ?? 'gpt-5.4-mini'
  const effort = process.env.OPENAI_TRANSCRIPTS_EFFORT ?? 'medium'

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      instructions: systemPrompt,
      input: userPrompt,
      reasoning: { effort },
      text: {
        format: {
          type: 'json_schema',
          name: 'submit_transcript_findings',
          strict: true,
          schema: TRANSCRIPT_ANALYSIS_SCHEMA,
        },
      },
    }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`OpenAI HTTP ${response.status}: ${text.slice(0, 500)}`)
  }

  const data = JSON.parse(text)
  if (data.error) {
    throw new Error(`OpenAI API error: ${data.error?.code} — ${data.error?.message}`)
  }

  const textOutput = data.output?.find((o: any) => o.type === 'message')
    ?.content?.find((c: any) => c.type === 'output_text')?.text ?? ''

  let parsed: any
  try {
    parsed = JSON.parse(textOutput)
  } catch (err: any) {
    throw new Error(`OpenAI returned non-JSON: ${err.message}. Preview: ${textOutput.slice(0, 300)}`)
  }

  return { parsed, model }
}

interface IncomingTranscript {
  id: string
  caseId: string
  transcript: string
  createdAt?: string
}

export async function POST(req: NextRequest) {
  const { transcripts } = (await req.json()) as { transcripts?: IncomingTranscript[] }

  if (!Array.isArray(transcripts) || transcripts.length === 0) {
    return NextResponse.json({ error: 'Provide a non-empty "transcripts" array' }, { status: 400 })
  }
  if (transcripts.length > 50) {
    return NextResponse.json({ error: 'Max 50 transcripts per batch' }, { status: 400 })
  }

  // Build the user prompt: clearly delimit each transcript with its CaseID so
  // the model can attribute findings correctly.
  const blocks = transcripts.map((t, i) => {
    const body = (t.transcript ?? '').slice(0, 12000)
    return `═══ TRANSCRIPT ${i + 1} of ${transcripts.length} ═══
CaseID: ${t.caseId || '(unknown)'}
${t.createdAt ? `CreatedAt: ${t.createdAt}` : ''}

${body}`
  })

  const userPrompt = `Analyse the following ${transcripts.length} transcripts. For each recurring patient question the bot deflected on, emit one finding per case.

${blocks.join('\n\n')}`

  try {
    const { parsed, model } = await callOpenAI(SYSTEM_PROMPT, userPrompt)
    return NextResponse.json({
      findings: parsed.findings ?? [],
      _meta: { model, batchSize: transcripts.length },
    })
  } catch (err: any) {
    console.error('transcripts/analyse error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
