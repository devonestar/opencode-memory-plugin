import { tool, type PluginOptions } from "@opencode-ai/plugin"

export type CurationConfig = {
  readonly enabled: boolean
  readonly allowProviderEgress: boolean
  readonly model: string
  readonly maxAgeDays: number
  readonly indexRatio: number
  readonly changedTopics: number
  readonly cooldownHours: number
  readonly timeoutSeconds: number
  readonly maxTopics: number
  readonly maxTopicBytes: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly notify: boolean
}

export const DEFAULT_CURATION_CONFIG = {
  enabled: true,
  allowProviderEgress: false,
  model: "openai/gpt-5.6-sol",
  maxAgeDays: 30,
  indexRatio: 0.7,
  changedTopics: 10,
  cooldownHours: 24,
  timeoutSeconds: 120,
  maxTopics: 200,
  maxTopicBytes: 32_768,
  maxInputBytes: 524_288,
  maxOutputBytes: 131_072,
  notify: true,
} satisfies CurationConfig

const z = tool.schema
const curationSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_CURATION_CONFIG.enabled),
    allowProviderEgress: z.boolean().default(DEFAULT_CURATION_CONFIG.allowProviderEgress),
    model: z.string().regex(/^(?:openai|anthropic)\/[^/\s]+$/).default(DEFAULT_CURATION_CONFIG.model),
    maxAgeDays: z.number().int().positive().max(3650).default(DEFAULT_CURATION_CONFIG.maxAgeDays),
    indexRatio: z.number().positive().max(1).default(DEFAULT_CURATION_CONFIG.indexRatio),
    changedTopics: z.number().int().positive().max(10_000).default(DEFAULT_CURATION_CONFIG.changedTopics),
    cooldownHours: z.number().nonnegative().max(8760).default(DEFAULT_CURATION_CONFIG.cooldownHours),
    timeoutSeconds: z.number().int().positive().max(3600).default(DEFAULT_CURATION_CONFIG.timeoutSeconds),
    maxTopics: z.number().int().positive().max(10_000).default(DEFAULT_CURATION_CONFIG.maxTopics),
    maxTopicBytes: z.number().int().min(64).max(10_000_000).default(DEFAULT_CURATION_CONFIG.maxTopicBytes),
    maxInputBytes: z.number().int().min(1024).max(100_000_000).default(DEFAULT_CURATION_CONFIG.maxInputBytes),
    maxOutputBytes: z.number().int().min(1024).max(10_000_000).default(DEFAULT_CURATION_CONFIG.maxOutputBytes),
    notify: z.boolean().default(DEFAULT_CURATION_CONFIG.notify),
  })
  .strict()

const optionsSchema = z.object({ curation: curationSchema.optional() }).strict()

export class CurationConfigError extends Error {
  readonly name = "CurationConfigError"
  constructor(readonly detail: string) {
    super(`invalid memory curation options: ${detail}`)
  }
}

export function parseCurationOptions(options: PluginOptions | undefined): CurationConfig {
  const parsed = optionsSchema.safeParse(options ?? {})
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "options"}: ${issue.message}`).join("; ")
    throw new CurationConfigError(detail)
  }
  return parsed.data.curation ?? DEFAULT_CURATION_CONFIG
}
