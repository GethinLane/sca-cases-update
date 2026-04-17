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
          suggestedText: { type: 'string' },
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
