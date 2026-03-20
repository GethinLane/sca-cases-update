// lib/ai-provider.ts
// Dual-provider abstraction: supports both OpenAI and Anthropic for the triage system.
// The existing analyse-case route is LEFT UNTOUCHED — it keeps using OpenAI as before.
//
// Set TRIAGE_AI_PROVIDER=anthropic|openai in your Vercel env to choose.
// Required env vars per provider:
//   anthropic → ANTHROPIC_API_KEY
//   openai    → OPENAI_API_KEY

export type TriageProvider = 'anthropic' | 'openai'

export function getTriageProvider(): TriageProvider {
  const provider = (process.env.TRIAGE_AI_PROVIDER ?? 'anthropic').toLowerCase()
  if (provider === 'openai') return 'openai'
  return 'anthropic' // default
}

// ─── Anthropic provider ───────────────────────────────────────────────

interface AnthropicTriageResult {
  textOutput: string
  searchCount: number
  citedUrls: string[]
}

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  maxSearches: number = 3,
): Promise<AnthropicTriageResult> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set')

  const model = process.env.TRIAGE_ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: maxSearches,
          // Restrict searches to UK clinical guideline sites for relevance + cost control
          allowed_domains: [
            'cks.nice.org.uk',
            'nice.org.uk',
            'bnf.nice.org.uk',
            'rcgp.org.uk',
            'bad.org.uk',
            'thebms.org.uk',
            'rcog.org.uk',
            'brit-thoracic.org.uk',
            'sign.ac.uk',
            'british-thyroid-association.org',
          ],
          user_location: {
            type: 'approximate',
            country: 'GB',
            region: 'England',
            timezone: 'Europe/London',
          },
        },
      ],
    }),
  })

  const data = await response.json()

  if (data.error) {
    throw new Error(`Anthropic API error: ${data.error?.message ?? JSON.stringify(data.error)}`)
  }

  // Extract text output from content blocks
  let textOutput = ''
  let searchCount = 0
  const citedUrls: string[] = []

  for (const block of data.content ?? []) {
    if (block.type === 'text') {
      textOutput = block.text

      // Extract cited URLs from citations in text blocks
      for (const citation of block.citations ?? []) {
        if (citation.url && !citedUrls.includes(citation.url)) {
          citedUrls.push(citation.url)
        }
      }
    }
    if (block.type === 'web_search_tool_result') {
      // Count search results and extract URLs
      for (const item of block.content ?? []) {
        if (item.type === 'web_search_result' && item.url) {
          if (!citedUrls.includes(item.url)) citedUrls.push(item.url)
        }
      }
    }
  }

  // Get search count from usage
  searchCount = data.usage?.server_tool_use?.web_search_requests ?? 0

  return { textOutput, searchCount, citedUrls }
}

// ─── OpenAI provider ──────────────────────────────────────────────────

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
): Promise<AnthropicTriageResult> {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set')

  const model = process.env.TRIAGE_OPENAI_MODEL ?? 'gpt-5.4-mini'

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
    }),
  })

  const data = await response.json()

  if (data.error) {
    throw new Error(`OpenAI API error: ${data.error?.code} — ${data.error?.message}`)
  }

  // Extract text output
  const textOutput = data.output?.find((o: any) => o.type === 'message')
    ?.content?.find((c: any) => c.type === 'output_text')?.text ?? ''

  // Extract cited URLs
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

  // Count search queries
  let searchCount = 0
  for (const block of data.output ?? []) {
    if (block.type === 'web_search_call') searchCount++
  }

  return { textOutput, searchCount, citedUrls }
}

// ─── Unified interface ────────────────────────────────────────────────

export interface TriageAIResult {
  textOutput: string
  searchCount: number
  citedUrls: string[]
  provider: TriageProvider
  model: string
}

export async function callTriageAI(
  systemPrompt: string,
  userPrompt: string,
  maxSearches: number = 3,
): Promise<TriageAIResult> {
  const provider = getTriageProvider()

  if (provider === 'anthropic') {
    const result = await callAnthropic(systemPrompt, userPrompt, maxSearches)
    return {
      ...result,
      provider: 'anthropic',
      model: process.env.TRIAGE_ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
    }
  } else {
    const result = await callOpenAI(systemPrompt, userPrompt)
    return {
      ...result,
      provider: 'openai',
      model: process.env.TRIAGE_OPENAI_MODEL ?? 'gpt-5.4-mini',
    }
  }
}
