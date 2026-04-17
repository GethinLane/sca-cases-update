// lib/ai-provider.ts
import { getAllGuidelineDomainStrings } from './guideline-domains'

export type TriageProvider = 'anthropic' | 'openai'

export function getTriageProvider(): TriageProvider {
  const provider = (process.env.TRIAGE_AI_PROVIDER ?? 'anthropic').toLowerCase()
  if (provider === 'openai') return 'openai'
  return 'anthropic'
}

export interface TriageAIResult {
  /**
   * Parsed JSON payload from the structured-output call.
   * Callers that previously parsed `textOutput` manually should now use this directly.
   */
  parsed: any
  /**
   * Raw text output from the model. Only populated when parsed is null (error fallback).
   * Kept for debugging/logging only — do not parse this.
   */
  textOutput: string
  searchCount: number
  citedUrls: string[]
  provider: TriageProvider
  model: string
}

// ─── Anthropic ────────────────────────────────────────────────────

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  schema: object,
  schemaName: string,
  maxSearches: number,
  modelOverride?: string,
): Promise<Omit<TriageAIResult, 'provider' | 'model'> & { model: string }> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set')

  const model = modelOverride ?? process.env.TRIAGE_ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'
  const isFullAnalysis = model.includes('sonnet') || model.includes('opus')
  const maxTokens = isFullAnalysis ? 12000 : 5000

  // Strategy: use a client tool `submit_analysis` whose input_schema is our desired JSON.
  // - Compatible with web_search (unlike output_config.format which blocks citations).
  // - Compatible with extended thinking (tool_choice stays "auto").
  // - Model calls web_search as needed, then submits final answer via submit_analysis.
  const submitAnalysisTool = {
    name: 'submit_analysis',
    description:
      'Submit your final analysis. Call this tool exactly once, as your final action, with the complete result. Do not respond with plain text.',
    input_schema: schema,
  }

  // Reinforce tool-use behaviour in the system prompt.
  const augmentedSystem = `${systemPrompt}

OUTPUT PROTOCOL:
- You have two tools: web_search (for verifying clinical facts) and submit_analysis (for returning your final result).
- Use web_search as many times as you need (up to ${maxSearches}) to verify claims against UK guidelines.
- When your analysis is complete, you MUST call submit_analysis exactly once with the full structured result.
- Do NOT return plain-text JSON. Only submit your answer via the submit_analysis tool call.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: [
        { type: 'text', text: augmentedSystem, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: userPrompt }],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: maxSearches,
          allowed_domains: getAllGuidelineDomainStrings(),
          user_location: {
            type: 'approximate',
            country: 'GB',
            region: 'England',
            timezone: 'Europe/London',
          },
        },
        submitAnalysisTool,
      ],
      // tool_choice left as default (auto) — forced tool use would break extended thinking
      // and would also prevent web_search from being called.
    }),
  })

  const data = await response.json()
  if (data.error) {
    throw new Error(`Anthropic API error: ${data.error?.message ?? JSON.stringify(data.error)}`)
  }

  let parsed: any = null
  let textOutput = ''
  const citedUrls: string[] = []

  for (const block of data.content ?? []) {
    if (block.type === 'text') {
      textOutput += (textOutput ? '\n' : '') + (block.text ?? '')
      for (const citation of block.citations ?? []) {
        if (citation.url && !citedUrls.includes(citation.url)) citedUrls.push(citation.url)
      }
    }
    if (block.type === 'tool_use' && block.name === schemaName) {
      // The tool `input` is the structured JSON we asked for.
      parsed = block.input
    }
    if (block.type === 'web_search_tool_result') {
      for (const item of block.content ?? []) {
        if (item.type === 'web_search_result' && item.url && !citedUrls.includes(item.url)) {
          citedUrls.push(item.url)
        }
      }
    }
  }

  // Also pull URLs that `parsed.sources` mentions, in case annotations missed them.
  if (parsed && Array.isArray(parsed.sources)) {
    for (const s of parsed.sources) {
      if (s?.url && !citedUrls.includes(s.url)) citedUrls.push(s.url)
    }
  }

  const searchCount = data.usage?.server_tool_use?.web_search_requests ?? 0

  if (!parsed) {
    throw new Error(
      `Anthropic did not call submit_analysis. Stop reason: ${data.stop_reason}. Text preview: ${textOutput.slice(0, 500)}`,
    )
  }

  return { parsed, textOutput, searchCount, citedUrls, model }
}

// ─── OpenAI ───────────────────────────────────────────────────────

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  schema: object,
  schemaName: string,
  effortOverride?: string,
  modelOverride?: string,
): Promise<Omit<TriageAIResult, 'provider' | 'model'> & { model: string }> {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set')

  const model = modelOverride ?? process.env.TRIAGE_OPENAI_MODEL ?? 'gpt-5.4-mini'
  const effort = effortOverride ?? process.env.OPENAI_REASONING_EFFORT ?? 'medium'

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      tools: [{ type: 'web_search_preview' }],
      instructions: systemPrompt,
      input: userPrompt,
      reasoning: { effort },
      text: {
        format: {
          type: 'json_schema',
          name: schemaName,
          strict: true,
          schema,
        },
      },
    }),
  })

  const data = await response.json()
  if (data.error) {
    throw new Error(`OpenAI API error: ${data.error?.code} — ${data.error?.message}`)
  }

  const textOutput = data.output?.find((o: any) => o.type === 'message')
    ?.content?.find((c: any) => c.type === 'output_text')?.text ?? ''

  const citedUrls: string[] = []
  for (const block of data.output ?? []) {
    if (block.type === 'message') {
      for (const content of block.content ?? []) {
        for (const annotation of content.annotations ?? []) {
          if (annotation.type === 'url_citation' && annotation.url) {
            if (!citedUrls.includes(annotation.url)) citedUrls.push(annotation.url)
          }
        }
      }
    }
  }

  let searchCount = 0
  for (const block of data.output ?? []) {
    if (block.type === 'web_search_call') searchCount++
  }

  // With strict json_schema, the response is guaranteed valid JSON. Parse directly.
  let parsed: any
  try {
    parsed = JSON.parse(textOutput)
  } catch (err: any) {
    throw new Error(`OpenAI returned non-JSON despite strict schema: ${err.message}. Preview: ${textOutput.slice(0, 300)}`)
  }

  // Merge URLs from the parsed sources array too.
  if (Array.isArray(parsed.sources)) {
    for (const s of parsed.sources) {
      if (s?.url && !citedUrls.includes(s.url)) citedUrls.push(s.url)
    }
  }

  return { parsed, textOutput, searchCount, citedUrls, model }
}

// ─── Public dispatcher ────────────────────────────────────────────

export interface CallTriageAIOptions {
  /** JSON schema describing the required output shape. */
  schema: object
  /** Name for the schema/tool (e.g. "submit_analysis"). */
  schemaName: string
  /** Max web_search calls. */
  maxSearches?: number
  /** Override the model (e.g. Sonnet for full analysis). */
  modelOverride?: string
  /** Override OpenAI reasoning effort (low|medium|high|xhigh). */
  effortOverride?: string
}

export async function callTriageAI(
  systemPrompt: string,
  userPrompt: string,
  opts: CallTriageAIOptions,
): Promise<TriageAIResult> {
  const provider = getTriageProvider()
  const maxSearches = opts.maxSearches ?? 3

  if (provider === 'anthropic') {
    const result = await callAnthropic(
      systemPrompt,
      userPrompt,
      opts.schema,
      opts.schemaName,
      maxSearches,
      opts.modelOverride,
    )
    return { ...result, provider: 'anthropic' }
  } else {
    const result = await callOpenAI(
      systemPrompt,
      userPrompt,
      opts.schema,
      opts.schemaName,
      opts.effortOverride,
      opts.modelOverride,
    )
    return { ...result, provider: 'openai' }
  }
}
