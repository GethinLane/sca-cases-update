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
Each transcript in the input is wrapped in an XML tag:

  <transcript idx="N" id="CASE_ID">
  User: ...
  Assistant: ...
  </transcript>

  • idx = its 1-based position in the batch (use this for "transcriptIndices" in your output).
  • id  = the CaseID that transcript belongs to (use this for "caseId" — but the server will also overwrite it from idx, so the indices MUST be correct).

INSIDE each transcript:
  "User:"       → the CANDIDATE (the doctor). They take a history, ask questions, give advice.
  "Assistant:"  → the BOT (the patient). They answer as the patient.

This is the OPPOSITE of how it might read at first glance. "User" is NOT the patient — it is the candidate/doctor. "Assistant" is the patient/bot.

═══════════════════════════════════════════════════════════════════════
CASE-ID ATTRIBUTION — DO NOT GUESS, DO NOT MIX TRANSCRIPTS
═══════════════════════════════════════════════════════════════════════
Every finding MUST list the exact idx values of the transcript(s) the deflection appeared in. If you list idx=5, the server WILL set caseId from that transcript's id attribute. So:

  • Only list an idx if you actually saw the deflection inside that <transcript> tag.
  • All idx values in one finding MUST share the same id (= same CaseID). If a question recurs across cases, emit SEPARATE findings — one per case.
  • Never copy a CaseID from a different transcript. Never invent a CaseID.

═══════════════════════════════════════════════════════════════════════
WHAT YOU ARE LOOKING FOR — INAPPROPRIATE DEFLECTIONS ONLY
═══════════════════════════════════════════════════════════════════════
You are NOT cataloguing every time the bot said "I don't know". A real human patient genuinely doesn't know lots of things — that's normal. You are looking ONLY for cases where the bot's "I don't know" / hedge is INAPPROPRIATE because it points to a gap in the case material.

There are exactly TWO categories of inappropriate deflection that count:

CATEGORY A — "the patient should have known this about themselves"
  The candidate asked about something a patient with this case would naturally know (their own history, current medications, symptoms, family, social context, work, etc.), and the bot answered with hedging because the case content simply didn't tell it.
  Examples of patient-self knowledge:
    • Do you smoke? How much? For how long?
    • What medications are you on? Do you take them regularly?
    • Have you had this symptom before?
    • Do you live alone? Who's at home?
    • Has anything like this happened to anyone in your family?
    • Have you ever had a colonoscopy / smear / mammogram?
    • How long have you had the pain?

CATEGORY B — "is that relevant here?" style meta-deflections
  Out-of-character lines where the bot questions WHY the candidate is asking, rather than answering as the patient:
    • "I'm not sure if that's relevant here"
    • "I don't know if you need to know that"
    • "Is that relevant to today?"
    • "I'm not sure why that matters"
    • "I don't really see how that's related"

═══════════════════════════════════════════════════════════════════════
WHAT TO IGNORE — DO NOT EMIT FINDINGS FOR ANY OF THESE
═══════════════════════════════════════════════════════════════════════
❌ Bot saying it doesn't know MEDICAL KNOWLEDGE. A patient wouldn't know:
   "What does Group B Strep mean?" → bot saying "I don't know much about it" = CORRECT BEHAVIOUR. SKIP.
   "What might the chest X-ray show?" → bot saying "I'm not sure" = CORRECT. SKIP.
   "What is causing the white cells?" → bot saying "I'm not sure" = CORRECT. SKIP.
   "What would reporting to the police involve?" → bot saying "I don't know what that would involve" = CORRECT. SKIP.

❌ Bot expressing emotional uncertainty or overwhelm:
   "I'm not sure, this is all just feeling overwhelming" = a normal emotional response. SKIP.

❌ Bot asking the doctor a question (patient curiosity is fine):
   "Could I just be seen tomorrow at the practice?" = patient question. SKIP.

❌ Bot hedging on minor sensory details ("I'm not sure exactly what time it started") UNLESS the candidate specifically pressed and the timing is clinically pivotal. Default = SKIP.

❌ Anything where the bot's answer actually contains real information ("No cuts that I can think of. I'm not sure about bruising.") — the bot answered "no cuts" and only hedged on bruising, which is a normal patient response. SKIP.

❌ Lines spoken by "User:" (the doctor). User hedges are never deflections.

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
2. exampleQuotes (the User: line that triggered it) and botResponse (the Assistant: line containing the hedge) MUST be DIFFERENT TEXT. If you can't find two different lines, it isn't a real deflection — drop it.
3. If no Assistant turn contains an INAPPROPRIATE hedge (Category A or B above), return { "findings": [] }. Empty is correct and expected most of the time.
4. The patient/Assistant asking the doctor questions is normal role-play — NEVER a deflection.
5. The doctor/User giving advice or admitting uncertainty is NEVER a bot turn — IGNORE.
6. Every finding MUST be assigned a deflectionType of "patient_should_have_known" (Category A) or "meta_relevance" (Category B). If you can't justify which category it fits, the finding doesn't qualify — drop it.
7. Better to return zero findings than to flag appropriate "I don't know"s.

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
    ?? 'gpt-5.4'
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

  // Wrap each transcript in an explicit <transcript> tag with idx + id
  // attributes. The model echoes the idx values back in transcriptIndices,
  // which we then use as the authoritative source for caseId — so a model
  // hallucination on caseId can't reach Airtable.
  const blocks = transcripts.map((t, i) => {
    const idx = i + 1
    const body = (t.transcript ?? '').slice(0, 12000)
    return `<transcript idx="${idx}" id="${(t.caseId || 'unknown').replace(/"/g, '&quot;')}"${t.createdAt ? ` createdAt="${t.createdAt}"` : ''}>
${body}
</transcript>`
  })

  const userPrompt = `Analyse the following ${transcripts.length} transcripts. Each is wrapped in a <transcript> tag whose "idx" attribute is its 1-based position in this batch and whose "id" attribute is the CaseID it belongs to.

For every finding you emit:
  • transcriptIndices = list every idx that contains the deflection (1-based).
  • caseId            = the id attribute of those transcripts (they MUST all share the same id; if they don't, you're grouping across cases — split them).

${blocks.join('\n\n')}`

  try {
    const { parsed, model } = await callOpenAI(SYSTEM_PROMPT, userPrompt)
    const rawFindings: any[] = Array.isArray(parsed?.findings) ? parsed.findings : []

    // Build the authoritative idx → caseId map from what we actually sent to
    // the model. This is the ONLY source of truth for caseId from here on.
    const idxToCaseId = new Map<number, string>()
    transcripts.forEach((t, i) => idxToCaseId.set(i + 1, t.caseId))

    const correctedFindings: any[] = []
    let overrideCount = 0
    let droppedCount = 0

    for (const f of rawFindings) {
      const indices: number[] = Array.isArray(f.transcriptIndices) ? f.transcriptIndices : []
      const realCaseIds = indices
        .map(i => idxToCaseId.get(i))
        .filter((v): v is string => typeof v === 'string' && v.length > 0)

      if (realCaseIds.length === 0) {
        // Model didn't tell us which transcript this came from — we can't
        // trust the caseId. Drop the finding rather than risk mis-attribution.
        console.warn('[transcripts/analyse] dropping finding with no valid transcriptIndices', {
          modelCaseId: f.caseId,
          indices,
        })
        droppedCount++
        continue
      }

      const uniqueCaseIds = Array.from(new Set(realCaseIds))
      if (uniqueCaseIds.length > 1) {
        // Model violated "one finding per case" — fan it out into one finding
        // per case to keep attribution honest.
        for (const cid of uniqueCaseIds) {
          const matchingIndices = indices.filter(i => idxToCaseId.get(i) === cid)
          correctedFindings.push({ ...f, caseId: cid, transcriptIndices: matchingIndices })
        }
        overrideCount++
        continue
      }

      const realCaseId = uniqueCaseIds[0]
      if (f.caseId !== realCaseId) {
        console.warn('[transcripts/analyse] overriding hallucinated caseId', {
          modelSaid: f.caseId,
          actual: realCaseId,
          indices,
        })
        overrideCount++
      }

      // Anti-mix-up guard: if exampleQuotes (User: line) and botResponse
      // (Assistant: line) are the same text, the model conflated the two
      // sides and the finding is unreliable.
      const normalised = (s: string) =>
        (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
      if (
        f.exampleQuotes &&
        f.botResponse &&
        normalised(f.exampleQuotes) === normalised(f.botResponse)
      ) {
        console.warn('[transcripts/analyse] dropping finding — exampleQuotes == botResponse', {
          caseId: realCaseId,
          text: String(f.exampleQuotes).slice(0, 120),
        })
        droppedCount++
        continue
      }

      correctedFindings.push({ ...f, caseId: realCaseId })
    }

    return NextResponse.json({
      findings: correctedFindings,
      _meta: {
        model,
        batchSize: transcripts.length,
        rawFindings: rawFindings.length,
        overrideCount,
        droppedCount,
      },
    })
  } catch (err: any) {
    console.error('transcripts/analyse error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
