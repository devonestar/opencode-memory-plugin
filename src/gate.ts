import { POINTER_MAX_CHARS } from "./config"
import { scanForSecret } from "./secrets"

export const MEMORY_SCOPES = ["global", "project"] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export const MIN_BODY_CHARS = 20

export type SaveGateInput = {
  readonly slug: string
  readonly description: string
  readonly body: string
}

export class SaveGateError extends Error {
  readonly name: string = "SaveGateError"
}

export class SecretDetectedError extends SaveGateError {
  readonly name: string = "SecretDetectedError"
  constructor(readonly kind: string) {
    super(`refused to save: content looks like a secret (${kind}); save a non-secret pointer instead`)
  }
}

export function isSafeDescription(description: string): boolean {
  return description.length > 0 && !/[\r\n\0]/.test(description) && !description.includes("```")
}

export function validateSaveInput(input: SaveGateInput, duplicateScope: MemoryScope | null = null): void {
  if (!isSafeDescription(input.description)) {
    throw new SaveGateError("refused to save: description must be one physical line without NUL or code-fence backticks")
  }
  const secret = scanForSecret(`${input.description}\n${input.body}`)
  if (secret !== null) throw new SecretDetectedError(secret.kind)

  const bodyChars = input.body.trim().length
  if (bodyChars < MIN_BODY_CHARS) {
    throw new SaveGateError(`refused to save: body is too short (${bodyChars} characters); provide at least ${MIN_BODY_CHARS} characters with the concrete durable learning`)
  }

  if (duplicateScope !== null) {
    throw new SaveGateError(
      `refused to save: slug "${input.slug}" already exists in ${duplicateScope} scope; update that memory instead of creating a cross-scope near-duplicate`,
    )
  }

  const pointer = unboundedPointerLine(input.slug, input.description)
  if (pointer.length > POINTER_MAX_CHARS) {
    throw new SaveGateError(
      `refused to save: index pointer is ${pointer.length} characters; shorten the slug or description so the complete pointer is at most ${POINTER_MAX_CHARS} characters`,
    )
  }
}

export function buildPointerLine(slug: string, description: string): string {
  const pointer = unboundedPointerLine(slug, description)
  if (pointer.length <= POINTER_MAX_CHARS) return pointer
  return `${pointer.slice(0, POINTER_MAX_CHARS - 1)}…`
}

function unboundedPointerLine(slug: string, description: string): string {
  return `- [${slug}](${slug}.md) — ${description}`
}
