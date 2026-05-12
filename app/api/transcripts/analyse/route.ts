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

═══════════════════════════════════════════════════════════════════════
TRANSCRIPT FORMAT — READ THIS FIRST OR YOU WILL GET ROLES BACKWARDS
═══════════════════════════════════════════════════════════════════════
Every transcript is a turn-by-turn conversation with these EXACT prefixes:

  "User:"       → the CANDIDATE (the doctor). They take a history, ask questions, give advice.
  "Assistant:"  → the BOT (the patient). They answer as the patient.

This is the OPPOSITE of how it might read at first glance. "User" is NOT the patient — it is the candidate/doctor. "Assistant" is the patient/bot.

═══════════════════════════════════════════════════════════════════════
WHAT YOU ARE LOOKING FOR
═══════════════════════════════════════════════════════════════════════
A "bot deflection" is when the CANDIDATE asks the patient something and the BOT (an "Assistant:" line) replies with hedging/uncertainty/refusal, e.g.:
  • "I'm not sure"
  • "I don't know"
  • "I'm not certain"
  • "I don't know if that's relevant"
  • "That's not something I'd remember"
  • "I don't have that information"
  • "I'm not sure how to answer that"

The DEFLECTION MUST APPEAR IN AN "Assistant:" LINE. If the hedge is in a "User:" line, that is the DOCTOR speaking — IGNORE IT.

═══════════════════════════════════════════════════════════════════════
EXAMPLES — DO vs DON'T
═══════════════════════════════════════════════════════════════════════
✅ COUNT this:
  User: Do you take your inhaler regularly?
  Assistant: Hmm, I'm not sure, I sometimes forget the evening dose.
→ Bot deflected on adherence. botResponse MUST quote the "Assistant:" line containing "I'm not sure".

❌ IGNORE this:
  Assistant: Can I just be seen at the practice tomorrow instead of going to hospital?
  User: The safest place would be A&E.
→ The PATIENT asked the DOCTOR for advice, and the DOCTOR answered. NO bot deflection happened. DO NOT emit a finding.

❌ IGNORE this:
  User: I'm not sure what's causing your symptoms yet, let me examine you.
→ The candidate said "I'm not sure". Candidate hedges are irrelevant — only Assistant: hedges count.

═══════════════════════════════════════════════════════════════════════
HARD RULES
═══════════════════════════════════════════════════════════════════════
1. NEVER emit a finding unless you can quote the EXACT "Assistant:" line containing the deflection phrase. Put that verbatim line in botResponse.
2. If no Assistant turn contains a hedge phrase, return { "findings": [] }. Empty is correct.
3. The patient/Assistant asking the doctor questions is normal role-play — NEVER a deflection.
4. The doctor/User giving advice or admitting uncertainty is NEVER a bot turn — IGNORE.
5. exampleQuotes must be the "User:" line(s) that PRECEDE the deflection — never an "Assistant:" line.
6. botResponse must be the "Assistant:" line(s) containing the hedge — never a "User:" line.
7. Better to return no findings than to fabricate ones.

═══════════════════════════════════════════════════════════════════════
ONE FINDING PER QUESTION-PER-CASE — HARD RULE
═══════════════════════════════════════════════════════════════════════
- Group transcripts by CaseID first. Then within each case, group equivalent paraphrases of the same question into ONE finding.
- "frequency" = how many transcripts WITH THAT CaseID contained this deflected question. Do NOT sum across cases.
- If the question recurs across cases, emit one finding per case.

═══════════════════════════════════════════════════════════════════════
CLINICAL RELEVANCE
═══════════════════════════════════════════════════════════════════════
- Yes → knowing the answer would plausibly change history-taking, diagnosis, differential, risk assessment, management, or safety-netting.
- No  → genuinely irrelevant chit-chat (clothing, hobbies, pet names).

For Yes findings, "suggestedAddition" = a copy/paste-ready sentence the case author can drop into the case content (specific to this case, not a meta-instruction). For No findings, suggestedAddition = "".

OUTPUT
Return a single JSON object matching the schema. If nothing in this batch qualifies, return { "findings": [] }.`

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
