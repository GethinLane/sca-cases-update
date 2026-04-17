// lib/ai-provider.ts
import { getAllGuidelineDomainStrings } from './guideline-domains'

export type TriageProvider = 'anthropic' | 'openai'

export function getTriageProvider(): TriageProvider {
  const provider = (process.env.TRIAGE_AI_PROVIDER ?? 'anthropic').toLowerCase()
  if (provider === 'openai') return 'openai'
  return 'anthropic'
}

export interface TriageAIResult {
  parsed: any
  textOutput: string
  searchCount: number
  citedUrls: string[]
  provider: TriageProvider
  model: string
}

// ─── Anthropic ────────────────────────────────────────────────────

interface AnthropicCallArgs {
  systemPrompt: string
  userPrompt: string
  schema: object
  schemaName: string
  maxSearches: number
  model: string
  maxTokens: number
  /** If true, force the submit tool and DO NOT include web_search. Used on retry. */
  forceSubmit?: boolean
  /** Prior assistant text (from a first attempt that failed to call the tool). */
  assistantPrefix?: string
}

async function anthropicRequest(args: AnthropicCallArgs) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set')

  const submitTool = {
    name: args.schemaName,
    description:
      'Submit your final analysis. Call this exactly once as your final action with the complete structured result. Do not respond with plain text.',
    input_schema: args.schema,
  }

  const tools: any[] = args.forceSubmit
    ? [submitTool]
    : [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: args.maxSearches,
          allowed_domains: getAllGuidelineDomainStrings(),
          user_location: {
            type: 'approximate',
            country: 'GB',
            region: 'England',
            timezone: 'Europe/London',
          },
        },
        submitTool,
      ]

  const messages: any[] = [{ role: 'user', content: args.userPrompt }]
  if (args.assistantPrefix) {
    messages.push({ role: 'assistant', content: args.assistantPrefix })
    messages.push({
      role: 'user',
      content:
        'You wrote your analysis as prose above. Now convert it into a submit_analysis tool call with the full structured result. Do not repeat the prose — just call the tool.',
    })
  }

  const body: any = {
    model: args.model,
    max_tokens: args.maxTokens,
    system: [
      { type: 'text', text: args.systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages,
    tools,
  }

  if (args.forceSubmit) {
    body.tool_choice = { type: 'tool', name: args.schemaName }
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  const data = await response.json()
  if (data.error) {
    throw new Error(`Anthropic API error: ${data.error?.message ?? JSON.stringify(data.error)}`)
  }
  return data
}

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  schema: object,
  schemaName: string,
  maxSearches: number,
  modelOverride?: string,
): Promise<Omit<TriageAIResult, 'provider'>> {
  const model = modelOverride ?? process.env.TRIAGE_ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'
  const isHeavy = model.includes('sonnet') || model.includes('opus')
  const maxTokens = isHeavy ? 12000 : 5000

  // Reinforce tool-use behaviour in the system prompt. Important: don't say
  // "don't use web_search" — just tell it the final answer must go via submit_analysis.
  const augmentedSystem = `${systemPrompt}

OUTPUT PROTOCOL — READ THIS BEFORE RESPONDING:
- You have two tools: web_search (for verifying clinical facts) and ${schemaName} (for returning your final result).
- Use web_search as many times as you need (up to ${maxSearches}) to verify claims.
- Your FINAL action in this response MUST be a call to ${schemaName} with the complete structured result.
- DO NOT write your analysis as plain text. DO NOT write "Based on my search..." and then summarise findings in prose.
- The only way to deliver your answer is by calling the ${schemaName} tool. Plain-text responses will be treated as incomplete and will waste a retry.`

  // ── First attempt: web_search + submit tool, tool_choice: auto ──
  let data = await anthropicRequest({
    systemPrompt: augmentedSystem,
    userPrompt,
    schema,
    schemaName,
    maxSearches,
    model,
    maxTokens,
  })

  const extractOutputs = (responseData: any) => {
    let parsed: any = null
    let textOutput = ''
    const urls: string[] = []
    for (const block of responseData.content ?? []) {
      if (block.type === 'text') {
        textOutput += (textOutput ? '\n' : '') + (block.text ?? '')
        for (const c of block.citations ?? []) {
          if (c.url && !urls.includes(c.url)) urls.push(c.url)
        }
      }
      if (block.type === 'tool_use' && block.name === schemaName) {
        parsed = block.input
      }
      if (block.type === 'web_search_tool_result') {
        for (const item of block.content ?? []) {
          if (item.type === 'web_search_result' && item.url && !urls.includes(item.url)) {
            urls.push(item.url)
          }
        }
      }
    }
    return { parsed, textOutput, urls }
  }

  let { parsed, textOutput, urls } = extractOutputs(data)
  let searchCount = data.usage?.server_tool_use?.web_search_requests ?? 0

  // ── Retry path: model wrote prose instead of calling the tool ──
  if (!parsed && textOutput.trim().length > 0) {
    console.log('[anthropic] submit tool not called on first attempt — retrying with forced tool choice')

    const retryData = await anthropicRequest({
      systemPrompt: augmentedSystem,
      userPrompt,
      schema,
      schemaName,
      maxSearches: 0,
      model,
      maxTokens,
      forceSubmit: true,
      assistantPrefix: textOutput,
    })

    const retry = extractOutputs(retryData)
    if (retry.parsed) {
      parsed = retry.parsed
      for (const u of retry.urls) if (!urls.includes(u)) urls.push(u)
    }
  }

  // Merge sources from the parsed result too, in case annotations missed anything
  if (parsed && Array.isArray(parsed.sources)) {
    for (const s of parsed.sources) {
      if (s?.url && !urls.includes(s.url)) urls.push(s.url)
    }
  }

  if (!parsed) {
    throw new Error(
      `Anthropic did not call ${schemaName} even after retry. Stop reason: ${data.stop_reason}. Text preview: ${textOutput.slice(0, 500)}`,
    )
  }

  return { parsed, textOutput, searchCount, citedUrls: urls, model }
}

// ─── OpenAI ───────────────────────────────────────────────────────

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  schema: object,
  schemaName: string,
  effortOverride?: string,
  modelOverride?: string,
): Promise<Omit<TriageAIResult, 'provider'>> {
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

  let parsed: any
  try {
    parsed = JSON.parse(textOutput)
  } catch (err: any) {
    throw new Error(`OpenAI returned non-JSON despite strict schema: ${err.message}. Preview: ${textOutput.slice(0, 300)}`)
  }

  if (Array.isArray(parsed.sources)) {
    for (const s of parsed.sources) {
      if (s?.url && !citedUrls.includes(s.url)) citedUrls.push(s.url)
    }
  }

  return { parsed, textOutput, searchCount, citedUrls, model }
}

// ─── Public dispatcher ────────────────────────────────────────────

export interface CallTriageAIOptions {
  schema: object
  schemaName: string
  maxSearches?: number
  modelOverride?: string
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
