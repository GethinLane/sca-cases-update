// lib/schemas.ts
// Central JSON schemas used for structured outputs.
// Shared between OpenAI (text.format: json_schema) and Anthropic (tool input_schema).

export const ANALYSE_CASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // Order matters: the model fills fields top-down, and verdict depends on the
  // self-check which depends on fieldChanges/summary. Keeping this order stops
  // the model from picking a verdict first and contradicting itself later.
  required: [
    'caseScenario',
    'summary',
    'sources',
    'fieldChanges',
    'verdictSelfCheck',
    'verdict',
    'verdictReason',
    'emailResponse',
  ],
  properties: {
    caseScenario: {
      type: 'string',
      description: 'Short paragraph describing the key clinical details from the case relevant to the feedback.',
    },
    summary: {
      type: 'string',
      description: 'Paragraph summarising whether the feedback is correct, applied to this specific patient.',
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url', 'finding'],
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          finding: { type: 'string' },
        },
      },
    },
    fieldChanges: {
      type: 'array',
      description:
        'Every distinct issue identified must appear here. If the summary acknowledges a problem, a fieldChange MUST exist for it. Empty array only valid when feedback was entirely incorrect or genuinely uncertain.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fieldName', 'currentText', 'issue', 'suggestedText', 'confidence'],
        properties: {
          fieldName: { type: 'string' },
          currentText: { type: 'string' },
          issue: { type: 'string' },
          suggestedText: {
            type: 'string',
            description:
              'Copy/paste-ready replacement text only. Must contain the finished rewritten wording for the field (or replacement passage), not editing instructions or summaries of what to change.',
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    verdictSelfCheck: {
      type: 'object',
      additionalProperties: false,
      required: ['fieldChangesCount', 'summaryAcknowledgesProblem', 'verdictRule'],
      description:
        'Mechanical self-check before committing to a verdict. Fill honestly based on the fields above.',
      properties: {
        fieldChangesCount: {
          type: 'integer',
          description: 'Count of entries in your fieldChanges array above.',
        },
        summaryAcknowledgesProblem: {
          type: 'boolean',
          description:
            'True if your summary contains ANY phrase acknowledging the user raised a valid point (e.g. "correct", "good point", "should be updated", "is reasonable", "valid issue"). False otherwise.',
        },
        verdictRule: {
          type: 'string',
          enum: [
            'changes_needed_partial_or_valid',
            'no_changes_feedback_was_wrong_so_invalid',
            'no_changes_cannot_determine_so_uncertain',
          ],
          description:
            'If fieldChangesCount > 0 OR summaryAcknowledgesProblem = true, MUST be "changes_needed_partial_or_valid". Only pick invalid/uncertain when both are false/0.',
        },
      },
    },
    verdict: {
      type: 'string',
      enum: ['valid', 'partial', 'invalid', 'uncertain'],
      description:
        'Must align with verdictSelfCheck.verdictRule: changes_needed_partial_or_valid → valid|partial; no_changes_feedback_was_wrong_so_invalid → invalid; no_changes_cannot_determine_so_uncertain → uncertain.',
    },
    verdictReason: {
      type: 'string',
      description: 'One or two sentence plain-English explanation of the verdict.',
    },
    emailResponse: {
      type: 'string',
      description: 'Draft email response, or exactly "No contact requested" if none needed.',
    },
  },
} as const

export const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'topic', 'summary', 'confidence', 'keySource'],
  properties: {
    status: { type: 'string', enum: ['up-to-date', 'review-needed', 'outdated'] },
    topic: { type: 'string', description: 'Short clinical topic name' },
    summary: {
      type: 'string',
      description: 'ONE paragraph, 3-5 sentences max, plain-English explanation of findings.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    keySource: { type: 'string', description: 'Single most important URL accessed' },
  },
} as const

/**
 * Schema for analysing a batch of bot/patient transcripts to find recurring
 * questions where the bot couldn't answer ("I don't know", "not relevant here",
 * "I'm not sure", etc.) and judging whether the missing info was clinically
 * relevant. One finding per distinct question per case.
 */
export const TRANSCRIPT_ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      description:
        'One entry per distinct question (in this batch) where the bot deflected, hedged, or said it did not know. Group equivalent paraphrases into a single entry and bump frequency. Skip questions that are clearly off-clinical (clothing, hobbies) UNLESS they recur often enough to be worth noting.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'transcriptIndices',
          'caseId',
          'question',
          'frequency',
          'clinicallyRelevant',
          'relevanceReason',
          'suggestedAddition',
          'exampleQuotes',
          'botResponse',
        ],
        properties: {
          transcriptIndices: {
            type: 'array',
            description:
              'The 1-based indices (matching "idx" attribute of the <transcript> tags) of every transcript in this batch that contributed to this finding. The server uses these to look up the real CaseID — getting them right is critical.',
            items: { type: 'integer', minimum: 1 },
            minItems: 1,
          },
          caseId: {
            type: 'string',
            description:
              'Copy the EXACT value of the "id" attribute from the <transcript> tag containing the deflection. Must match the id of every transcript listed in transcriptIndices (all transcriptIndices in one finding must belong to the same case). The server will overwrite this with the authoritative value — but if you put the wrong one here, your transcriptIndices are probably wrong too.',
          },
          question: {
            type: 'string',
            description:
              'The recurring patient question, normalised to a clean canonical phrasing (not a verbatim quote).',
          },
          frequency: {
            type: 'integer',
            minimum: 1,
            description:
              'How many times THIS specific question (or a clear paraphrase) was asked AND triggered a bot deflection FOR THIS caseId in this batch. Scope = transcripts whose CaseID matches the caseId field. Do NOT count occurrences from other cases — emit a separate finding per case if the question recurs across cases.',
          },
          clinicallyRelevant: {
            type: 'string',
            enum: ['Yes', 'No'],
            description:
              'Yes if knowing the answer would plausibly change the consultation (history-taking, diagnosis, risk assessment, management, safety-netting). No for irrelevant chit-chat (e.g. clothing, hobbies, names of pets).',
          },
          relevanceReason: {
            type: 'string',
            description:
              'One sentence explaining why this is or is not clinically relevant for this case.',
          },
          suggestedAddition: {
            type: 'string',
            description:
              'If clinically relevant: a copy/paste-ready sentence the case author can add to the case content to answer this question. If not relevant: empty string.',
          },
          exampleQuotes: {
            type: 'string',
            description:
              'Up to 3 short verbatim USER (candidate) quotes from transcripts that triggered the bot hedge, separated by " | ".',
          },
          botResponse: {
            type: 'string',
            description:
              'Up to 3 short verbatim BOT (patient) responses showing how it deflected — e.g. "I\'m not sure", "I don\'t know if that matters", "That\'s not in my notes". Separated by " | ".',
          },
        },
      },
    },
  },
} as const

export const FULL_ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'fieldChanges', 'sources'],
  properties: {
    verdict: { type: 'string', enum: ['up-to-date', 'changes-needed'] },
    summary: { type: 'string' },
    fieldChanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fieldName', 'currentText', 'issue', 'suggestedText', 'confidence', 'source'],
        properties: {
          fieldName: { type: 'string' },
          currentText: { type: 'string' },
          issue: { type: 'string' },
          suggestedText: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          source: { type: 'string' },
        },
      },
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url', 'finding'],
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          finding: { type: 'string' },
        },
      },
    },
  },
} as const
