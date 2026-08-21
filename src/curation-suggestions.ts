import { createHash } from "node:crypto"
import { join } from "node:path"
import { tool } from "@opencode-ai/plugin"
import { withLock } from "./fsutil"
import { PrivateLimitError, readPrivateBytesBounded } from "./private-contained"
import { ensurePrivateDir, writePrivate } from "./private-fs"
import type { ProposalOperation, ProposalSource, Replacement } from "./proposal"

export const CURATION_SUGGESTION_MAX_ENTRIES = 200
export const CURATION_SUGGESTION_MAX_BYTES = 512 * 1024
export const CURATION_SUGGESTION_CLAIM_MAX = 10
const CURATION_SUGGESTION_SOURCE_PREVIEW_MAX = 2

export type CurationSuggestionSourcePreview = Pick<ProposalSource, "scope" | "slug">

export type CurationSuggestion = {
  readonly key: string
  readonly runId: string
  readonly operationId: string
  readonly kind: ProposalOperation["kind"]
  readonly reasonCode: string
  readonly sourcePreview: readonly CurationSuggestionSourcePreview[]
  readonly sourceCount: number
  readonly destination: Pick<Replacement, "scope" | "slug"> | null
  readonly createdAt: number
  readonly updatedAt: number
}

export type AddCurationSuggestion = {
  readonly runId: string
  readonly operation: ProposalOperation
  readonly at: number
}

export type CurationSuggestionPaths = {
  readonly root: string
  readonly inbox: string
  readonly lock: string
}

export type CurationSuggestionRepository = {
  readonly paths: CurationSuggestionPaths
  list(): Promise<readonly CurationSuggestion[]>
  add(input: AddCurationSuggestion): Promise<CurationSuggestion>
  addMany(inputs: readonly AddCurationSuggestion[]): Promise<readonly CurationSuggestion[]>
  claim(limit: number, fits: (suggestions: readonly CurationSuggestion[]) => boolean): Promise<readonly CurationSuggestion[]>
}

export type RecordCurationSuggestionsInput = {
  readonly runId: string
  readonly operations: readonly ProposalOperation[]
  readonly at: number
}

const z = tool.schema
const HASH_RE = /^[a-f0-9]{64}$/
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,127}$/
const OPERATION_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/
const REASON_RE = /^[a-z][a-z0-9-]*$/
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
const sourcePreviewSchema = z.object({ scope: z.enum(["global", "project"]), slug: z.string().regex(SLUG_RE) }).strict()
const destinationSchema = z.object({ scope: z.enum(["global", "project"]), slug: z.string().regex(SLUG_RE) }).strict()
const entrySchema = z.object({
  key: z.string().regex(HASH_RE),
  runId: z.string().regex(LABEL_RE),
  operationId: z.string().regex(OPERATION_ID_RE),
  kind: z.enum(["KEEP", "DELETE", "REWRITE", "MERGE", "RESCOPE"]),
  reasonCode: z.string().regex(REASON_RE),
  sourcePreview: z.array(sourcePreviewSchema).min(1).max(CURATION_SUGGESTION_SOURCE_PREVIEW_MAX),
  sourceCount: z.number().int().positive(),
  destination: destinationSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()
const inboxSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(CURATION_SUGGESTION_MAX_ENTRIES) }).strict()

export class CurationSuggestionInboxError extends TypeError {
  readonly name = "CurationSuggestionInboxError"
  constructor(readonly detail: string) {
    super(`curation suggestion inbox is malformed: ${detail}`)
  }
}

export class CurationSuggestionClaimLimitError extends RangeError {
  readonly name = "CurationSuggestionClaimLimitError"
  constructor(readonly limit: number) {
    super(`curation suggestion claim limit must be an integer from 1 through ${CURATION_SUGGESTION_CLAIM_MAX}: ${String(limit)}`)
  }
}

function replacementOf(operation: ProposalOperation): Replacement | null {
  switch (operation.kind) {
    case "KEEP":
    case "DELETE":
      return null
    case "REWRITE":
    case "MERGE":
    case "RESCOPE":
      return operation.replacement
    default:
      return assertNever(operation)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected curation operation: ${JSON.stringify(value)}`)
}

function sortedSources(sources: readonly ProposalSource[]): readonly ProposalSource[] {
  return [...sources].sort((left, right) => {
    const leftKey = `${left.scope}:${left.slug}:${left.sha256}`
    const rightKey = `${right.scope}:${right.slug}:${right.sha256}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

export function suggestionFingerprint(operation: ProposalOperation): string {
  const replacement = replacementOf(operation)
  const canonical = {
    kind: operation.kind,
    reasonCode: operation.reasonCode,
    sources: sortedSources(operation.sources),
    destination: replacement === null ? null : { scope: replacement.scope, slug: replacement.slug },
    replacement: replacement === null
      ? null
      : { scope: replacement.scope, slug: replacement.slug, type: replacement.type, description: replacement.description, body: replacement.body },
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

export async function recordCurationSuggestions(
  repository: CurationSuggestionRepository,
  input: RecordCurationSuggestionsInput,
): Promise<number> {
  const actionable = input.operations.filter((operation) => operation.kind !== "KEEP")
  await repository.addMany(actionable.map((operation) => ({ runId: input.runId, operation, at: input.at })))
  return actionable.length
}

export function curationOutcomeSummary(actionableSuggestions: number, exactMerges: number): string {
  const suggestions = `${actionableSuggestions} actionable suggestion${actionableSuggestions === 1 ? "" : "s"} recorded`
  const merges = exactMerges === 0 ? "no exact merges applied" : `${exactMerges} exact merge${exactMerges === 1 ? "" : "s"} applied`
  return `${suggestions}; ${merges}`
}

async function load(root: string, path: string): Promise<readonly CurationSuggestion[]> {
  let raw: string
  try {
    raw = (await readPrivateBytesBounded(root, path, CURATION_SUGGESTION_MAX_BYTES)).bytes.toString("utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    if (error instanceof PrivateLimitError) throw new CurationSuggestionInboxError("file exceeds byte limit")
    throw error
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch (error) {
    if (error instanceof SyntaxError) throw new CurationSuggestionInboxError("invalid JSON")
    throw error
  }
  const parsed = inboxSchema.safeParse(decoded)
  if (!parsed.success) throw new CurationSuggestionInboxError(parsed.error.message)
  return parsed.data.entries
}

async function save(root: string, path: string, entries: readonly CurationSuggestion[]): Promise<void> {
  const parsed = inboxSchema.safeParse({ version: 1, entries })
  if (!parsed.success) throw new CurationSuggestionInboxError(parsed.error.message)
  const raw = `${JSON.stringify(parsed.data, null, 2)}\n`
  if (Buffer.byteLength(raw, "utf8") > CURATION_SUGGESTION_MAX_BYTES) throw new CurationSuggestionInboxError("file exceeds byte limit")
  await writePrivate(root, path, raw)
}

export function createCurationSuggestionRepository(globalDir: string, namespace: string): CurationSuggestionRepository {
  if (!LABEL_RE.test(namespace)) throw new CurationSuggestionInboxError("invalid namespace")
  const root = join(globalDir, ".curation", "projects", namespace)
  const paths = { root, inbox: join(root, "suggestions.json"), lock: join(root, "suggestions.lock") }
  const locked = async <T>(work: () => Promise<T>): Promise<T> => {
    await ensurePrivateDir(globalDir, root)
    return withLock(paths.lock, work)
  }
  const addMany = async (inputs: readonly AddCurationSuggestion[]): Promise<readonly CurationSuggestion[]> => {
    if (inputs.length === 0) return []
    return locked(async () => {
      const entries = new Map((await load(globalDir, paths.inbox)).map((entry) => [entry.key, entry]))
      const added: CurationSuggestion[] = []
      for (const input of inputs) {
        const key = suggestionFingerprint(input.operation)
        const existing = entries.get(key)
        const replacement = replacementOf(input.operation)
        const sources = sortedSources(input.operation.sources)
        const entry: CurationSuggestion = {
          key,
          runId: input.runId,
          operationId: input.operation.id,
          kind: input.operation.kind,
          reasonCode: input.operation.reasonCode,
          sourcePreview: sources.slice(0, CURATION_SUGGESTION_SOURCE_PREVIEW_MAX).map(({ scope, slug }) => ({ scope, slug })),
          sourceCount: sources.length,
          destination: replacement === null ? null : { scope: replacement.scope, slug: replacement.slug },
          createdAt: existing?.createdAt ?? input.at,
          updatedAt: input.at,
        }
        entries.set(key, entry)
        added.push(entry)
      }
      const next = [...entries.values()]
        .sort((left, right) => left.createdAt - right.createdAt || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
        .slice(-CURATION_SUGGESTION_MAX_ENTRIES)
      await save(globalDir, paths.inbox, next)
      return added
    })
  }
  return {
    paths,
    list: () => load(globalDir, paths.inbox),
    add: async (input) => {
      const entry = (await addMany([input]))[0]
      if (entry === undefined) throw new CurationSuggestionInboxError("single suggestion batch produced no entry")
      return entry
    },
    addMany,
    claim: async (limit, fits) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > CURATION_SUGGESTION_CLAIM_MAX) throw new CurationSuggestionClaimLimitError(limit)
      if ((await load(globalDir, paths.inbox)).length === 0) return []
      await ensurePrivateDir(globalDir, root)
      return withLock(paths.lock, async () => {
        const entries = await load(globalDir, paths.inbox)
        if (entries.length === 0) return []
        for (let count = Math.min(limit, entries.length); count >= 1; count -= 1) {
          const candidate = entries.slice(0, count)
          if (!fits(candidate)) continue
          await save(globalDir, paths.inbox, entries.slice(count))
          return candidate
        }
        return []
      }, { retryMs: 0, maxRetries: 1, sleep: async () => undefined })
    },
  }
}
