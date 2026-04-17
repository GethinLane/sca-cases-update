// lib/schemas.ts
// Central JSON schemas used for structured outputs.
// Shared between OpenAI (text.format: json_schema) and Anthropic (tool input_schema).
//
// Design notes:
// - OpenAI strict mode requires every property to be "required" and additionalProperties:false.
//   Optional fields are modelled as "required but may be empty string" where feasible.
// - These are plain JSON Schema objects so they can be dropped into either provider.

export const ANALYSE_CASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'verdict',
    'verdictReason',
    'caseScenario',
    'summary',
    'sources',
    'fieldChanges',
    'emailResponse',
  ],
  properties: {
    verdict: {
      type: 'string',
      enum: ['valid', 'invalid', 'partial', 'uncertain'],
      description: 'Whether the user\'s feedback is correct. NOT whether the case is correct.',
    },
    verdictReason: {
      type: 'string',
      description: 'One or two sentence plain-English explanation of the verdict.',
    },
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
    emailResponse: {
      type: 'string',
      description: 'Draft email response, or "No contact requested" if none needed.',
    },
  },
} as const

export const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'topic', 'summary', 'confidence', 'keySource'],
  properties: {
    status: {
      type: 'string',
      enum: ['up-to-date', 'review-needed', 'outdated'],
    },
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
    verdict: {
      type: 'string',
      enum: ['up-to-date', 'changes-needed'],
    },
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
