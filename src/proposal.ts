import { tool } from "@opencode-ai/plugin"
import type { CurationConfig } from "./curation-config"
import { MEMORY_TYPES, isValidSlug, serializeMemory, type MemoryType } from "./frontmatter"
import { isSafeDescription, MEMORY_SCOPES, validateSaveInput, type MemoryScope } from "./gate"
import { scanForSecret } from "./secrets"
import type { MemorySnapshot, SnapshotTopic } from "./snapshot"

const z = tool.schema

export type ProposalSource = {
  readonly scope: MemoryScope
  readonly slug: string
  readonly sha256: string
}

export type Replacement = {
  readonly scope: MemoryScope
  readonly slug: string
  readonly type: MemoryType
  readonly description: string
  readonly body: string
}

const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
const FINDING_REFERENCE_RE = /^(?:(?:global|project):)?[a-z0-9][a-z0-9-]*$/

const findingReferenceSchema = z.string().regex(FINDING_REFERENCE_RE)
export type FindingReference = string

type OperationBase = {
  readonly id: string
  readonly confidence: "high" | "medium" | "low"
  readonly reasonCode: string
  readonly sources: readonly ProposalSource[]
}

export type ProposalOperation =
  | (OperationBase & { readonly kind: "KEEP" })
  | (OperationBase & { readonly kind: "DELETE" })
  | (OperationBase & { readonly kind: "REWRITE"; readonly replacement: Replacement })
  | (OperationBase & { readonly kind: "MERGE"; readonly replacement: Replacement })
  | (OperationBase & { readonly kind: "RESCOPE"; readonly replacement: Replacement })

export type MutatingOperation = Exclude<ProposalOperation, { readonly kind: "KEEP" }>

export type CurationProposal = {
  readonly version: 1
  readonly snapshotSha256: string
  readonly operations: readonly ProposalOperation[]
  readonly findings: readonly { readonly kind: string; readonly slugs: readonly FindingReference[]; readonly summary: string }[]
  readonly summary: { readonly reviewed: number; readonly highConfidence: number; readonly ambiguous: number }
}

export type ProposalValidation = {
  readonly proposal: CurationProposal
  readonly applicable: readonly MutatingOperation[]
  readonly reportOnly: readonly ProposalOperation[]
  readonly errors: readonly string[]
  readonly summary: { readonly reviewed: number; readonly highConfidence: number; readonly ambiguous: number }
}

export const AUTOMATIC_REASON_CODES = ["duplicate-exact"] as const

export class ProposalParseError extends Error {
  readonly name = "ProposalParseError"
  constructor(readonly detail: string) {
    super(`curator result rejected: ${detail}`)
  }
}

const sourceSchema = z.object({ scope: z.enum(MEMORY_SCOPES), slug: z.string().regex(SAFE_SLUG_RE), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const replacementSchema = z
  .object({
    scope: z.enum(MEMORY_SCOPES),
    slug: z.string().regex(SAFE_SLUG_RE),
    type: z.enum(MEMORY_TYPES),
    description: z.string().min(1).max(200).refine(isSafeDescription, "description must be one physical line without NUL or code-fence backticks"),
    body: z.string().min(1),
  })
  .strict()
const SAFE_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,99}$/
const base = { id: z.string().regex(SAFE_LABEL_RE), confidence: z.enum(["high", "medium", "low"]), reasonCode: z.string().regex(/^[a-z][a-z0-9-]*$/), sources: z.array(sourceSchema).min(1) }
const operationSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("KEEP") }).strict(),
  z.object({ ...base, kind: z.literal("DELETE") }).strict(),
  z.object({ ...base, kind: z.literal("REWRITE"), replacement: replacementSchema }).strict(),
  z.object({ ...base, kind: z.literal("MERGE"), replacement: replacementSchema }).strict(),
  z.object({ ...base, kind: z.literal("RESCOPE"), replacement: replacementSchema }).strict(),
])
const proposalSchema = z
  .object({
    version: z.literal(1),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    operations: z.array(operationSchema),
    findings: z.array(z.object({ kind: z.string().regex(SAFE_LABEL_RE), slugs: z.array(findingReferenceSchema).max(200), summary: z.string().min(1).max(1000).refine((value) => !/[\x00-\x1f\x7f]/.test(value), "finding summary must not contain control characters").refine((value) => scanForSecret(value) === null, "finding summary contains secret-like content") }).strict()).max(200),
    summary: z.object({ reviewed: z.number().int().nonnegative(), highConfidence: z.number().int().nonnegative(), ambiguous: z.number().int().nonnegative() }).strict(),
  })
  .strict()

export function parseProposal(raw: string): CurationProposal {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch (error) {
    if (error instanceof SyntaxError) throw new ProposalParseError("output is not one plain JSON object")
    throw error
  }
  const parsed = proposalSchema.safeParse(decoded)
  if (!parsed.success) throw new ProposalParseError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
  return parsed.data
}

function key(scope: MemoryScope, slug: string): string {
  return `${scope}:${slug}`
}

type MemoryContent = Pick<SnapshotTopic, "type" | "description" | "body">

function sameContent(left: MemoryContent, right: MemoryContent): boolean {
  return left.type === right.type && left.description === right.description && left.body === right.body
}

function localSurvivor(sources: readonly SnapshotTopic[]): SnapshotTopic | undefined {
  const global = sources.filter((source) => source.scope === "global")
  return [...(global.length > 0 ? global : sources)].sort((left, right) => key(left.scope, left.slug).localeCompare(key(right.scope, right.slug)))[0]
}

function validateExactDuplicate(operation: MutatingOperation, sources: readonly SnapshotTopic[], errors: string[]): SnapshotTopic | undefined {
  const first = sources[0]
  if (first === undefined) return undefined
  if (operation.kind !== "MERGE" || sources.length < 2) {
    errors.push(`${operation.id}: duplicate-exact must be a MERGE with at least two sources`)
    return undefined
  }
  const destinationIsSource = operation.sources.some((source) => source.scope === operation.replacement.scope && source.slug === operation.replacement.slug)
  if (!destinationIsSource || sources.some((topic) => !sameContent(first, topic)) || !sameContent(first, operation.replacement)) {
    errors.push(`${operation.id}: duplicate-exact must preserve type, exact description, exact body, and one source destination`)
  }
  return localSurvivor(sources)
}

function validateReplacement(operation: MutatingOperation, snapshot: MemorySnapshot, config: CurationConfig, errors: string[]): void {
  if (operation.kind === "DELETE") return
  const replacement = operation.replacement
  if (!isValidSlug(replacement.slug)) errors.push(`${operation.id}: replacement slug is unsafe`)
  try {
    validateSaveInput(replacement)
  } catch (error) {
    if (error instanceof Error) errors.push(`${operation.id}: replacement ${error.message}`)
    else throw error
  }
  const bytes = Buffer.byteLength(serializeMemory({ name: replacement.slug, description: replacement.description, type: replacement.type }, replacement.body), "utf8")
  if (bytes > config.maxTopicBytes) errors.push(`${operation.id}: replacement exceeds maxTopicBytes`)
  const sourceKeys = new Set(operation.sources.map((source) => key(source.scope, source.slug)))
  const occupied = snapshot.topics.find((topic) => topic.scope === replacement.scope && topic.slug === replacement.slug)
  if (occupied !== undefined && !sourceKeys.has(key(occupied.scope, occupied.slug))) errors.push(`${operation.id}: destination is occupied`)
  const crossScope = snapshot.topics.find((topic) => topic.scope !== replacement.scope && topic.slug === replacement.slug)
  if (crossScope !== undefined && !sourceKeys.has(key(crossScope.scope, crossScope.slug))) errors.push(`${operation.id}: destination conflicts across scopes`)
}

export function validateProposal(proposal: CurationProposal, snapshot: MemorySnapshot, config: CurationConfig): ProposalValidation {
  const errors: string[] = []
  const applicable: MutatingOperation[] = []
  const reportOnly: ProposalOperation[] = []
  if (proposal.snapshotSha256 !== snapshot.sha256) errors.push("snapshot digest does not match")
  const highConfidence = proposal.operations.filter((operation) => operation.confidence === "high").reduce((total, operation) => total + operation.sources.length, 0)
  const ambiguous = proposal.operations.filter((operation) => operation.confidence !== "high").reduce((total, operation) => total + operation.sources.length, 0)
  const summary = { reviewed: snapshot.topics.length, highConfidence, ambiguous }
  const ids = new Set<string>()
  const coverage = new Map<string, number>()
  const destinations = new Set<string>()
  const topics = new Map(snapshot.topics.map((topic) => [key(topic.scope, topic.slug), topic]))
  for (const operation of proposal.operations) {
    if (ids.has(operation.id)) errors.push(`duplicate operation id: ${operation.id}`)
    ids.add(operation.id)
    const sources: SnapshotTopic[] = []
    for (const source of operation.sources) {
      const sourceKey = key(source.scope, source.slug)
      coverage.set(sourceKey, (coverage.get(sourceKey) ?? 0) + 1)
      const topic = topics.get(sourceKey)
      if (topic === undefined || topic.sha256 !== source.sha256) errors.push(`${operation.id}: source ownership or hash mismatch for ${source.scope}:${source.slug}`)
      else sources.push(topic)
    }
    if (operation.kind === "KEEP" || operation.confidence !== "high" || operation.reasonCode !== AUTOMATIC_REASON_CODES[0]) {
      reportOnly.push(operation)
      continue
    }
    const survivor = validateExactDuplicate(operation, sources, errors)
    const normalized = operation.kind === "MERGE" && survivor !== undefined
      ? { ...operation, replacement: { scope: survivor.scope, slug: survivor.slug, type: survivor.type, description: survivor.description, body: survivor.body } }
      : operation
    validateReplacement(normalized, snapshot, config, errors)
    if (normalized.kind !== "DELETE") {
      const destination = key(normalized.replacement.scope, normalized.replacement.slug)
      if (destinations.has(destination)) errors.push(`${operation.id}: destination conflicts with another operation`)
      destinations.add(destination)
    }
    applicable.push(normalized)
  }
  for (const topic of snapshot.topics) {
    const topicKey = key(topic.scope, topic.slug)
    const count = coverage.get(topicKey) ?? 0
    if (count > 1) errors.push(`snapshot topic repeated across operation sources: ${topicKey}`)
  }
  const resulting = new Map(snapshot.topics.map((topic) => [key(topic.scope, topic.slug), topic.bytes]))
  for (const operation of applicable) {
    for (const source of operation.sources) resulting.delete(key(source.scope, source.slug))
    if (operation.kind !== "DELETE") {
      const replacement = operation.replacement
      const bytes = Buffer.byteLength(serializeMemory({ name: replacement.slug, description: replacement.description, type: replacement.type }, replacement.body), "utf8")
      resulting.set(key(replacement.scope, replacement.slug), bytes)
    }
  }
  if (resulting.size > config.maxTopics) errors.push("resulting topic count exceeds maxTopics")
  const resultingBytes = [...resulting.values()].reduce((total, bytes) => total + bytes, 0) + snapshot.indexes.reduce((total, index) => total + index.bytes, 0)
  if (resultingBytes > config.maxInputBytes) errors.push("resulting memory exceeds maxInputBytes")
  if (errors.length > 0) return { proposal, applicable: [], reportOnly, errors, summary }
  return { proposal, applicable, reportOnly, errors, summary }
}
