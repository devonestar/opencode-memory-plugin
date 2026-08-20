import { tool, type PluginOptions } from "@opencode-ai/plugin"

export type InjectionConfig = {
  readonly maxBlockBytes: number
  readonly pointerBudgetBytes: number
  readonly pointerMaxLines: number
  readonly projectShare: number
}

/** Defaults mirror the previously hard-coded prompt budgets exactly; omitting the option group preserves historical behavior. */
export const DEFAULT_INJECTION_CONFIG = {
  maxBlockBytes: 10_000,
  pointerBudgetBytes: 8_000,
  pointerMaxLines: 80,
  projectShare: 0.6,
} satisfies InjectionConfig

const z = tool.schema

const injectionSchema = z
  .object({
    maxBlockBytes: z.number().int().min(2_048).max(100_000).default(DEFAULT_INJECTION_CONFIG.maxBlockBytes),
    pointerBudgetBytes: z.number().int().min(512).max(100_000).default(DEFAULT_INJECTION_CONFIG.pointerBudgetBytes),
    pointerMaxLines: z.number().int().min(1).max(1_000).default(DEFAULT_INJECTION_CONFIG.pointerMaxLines),
    projectShare: z.number().min(0.05).max(0.95).default(DEFAULT_INJECTION_CONFIG.projectShare),
  })
  .strict()

/** Sibling option groups are validated by their own parsers; this schema only rejects keys no parser owns. */
const optionsSchema = z.object({ curation: z.unknown().optional(), injection: injectionSchema.optional() }).strict()

export class InjectionConfigError extends Error {
  readonly name = "InjectionConfigError"
  constructor(readonly detail: string) {
    super(`invalid memory injection options: ${detail}`)
  }
}

export function parseInjectionOptions(options: PluginOptions | undefined): InjectionConfig {
  const parsed = optionsSchema.safeParse(options ?? {})
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "options"}: ${issue.message}`).join("; ")
    throw new InjectionConfigError(detail)
  }
  return parsed.data.injection ?? DEFAULT_INJECTION_CONFIG
}
