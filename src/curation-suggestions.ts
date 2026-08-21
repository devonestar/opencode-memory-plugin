import { createHash } from "node:crypto"
import { join } from "node:path"
import { tool } from "@opencode-ai/plugin"
import { withLock } from "./fsutil"
import { ensurePrivateDir, readPrivate, writePrivate } from "./private-fs"
import type { ProposalOperation, ProposalSource, Replacement } from "./proposal"

export const CURATION_SUGGESTION_MAX_ENTRIES = 200
export const CURATION_SUGGESTION_MAX_BYTES = 512 * 1024
export const CURATION_SUGGESTION_CLAIM_MAX = 10

export type CurationSuggestion = {
  readonly key: string
  readonly runId: string
  readonly operationId: string
  readonly kind: ProposalOperation["kind"]
  readonly reasonCode: string
  readonly sources: readonly ProposalSource[]
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
  claim(limit: number): Promise<readonly CurationSuggestion[]>
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
const REASON_RE = /^[a-z][a-z0-9-]{0,99}$/
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/
const sourceSchema = z.object({ scope: z.enum(["global", "project"]), slug: z.string().regex(SLUG_RE), sha256: z.string().regex(HASH_RE) }).strict()
const destinationSchema = z.object({ scope: z.enum(["global", "project"]), slug: z.string().regex(SLUG_RE) }).strict()
const entrySchema = z.object({
  key: z.string().regex(HASH_RE),
  runId: z.string().regex(LABEL_RE),
  operationId: z.string().regex(OPERATION_ID_RE),
  kind: z.enum(["KEEP", "DELETE", "REWRITE", "MERGE", "RESCOPE"]),
  reasonCode: z.string().regex(REASON_RE),
  sources: z.array(sourceSchema).min(1).max(200),
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
  for (const operation of actionable) await repository.add({ runId: input.runId, operation, at: input.at })
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
    raw = await readPrivate(root, path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
  if (Buffer.byteLength(raw, "utf8") > CURATION_SUGGESTION_MAX_BYTES) throw new CurationSuggestionInboxError("file exceeds byte limit")
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
  return {
    paths,
    list: () => load(globalDir, paths.inbox),
    add: (input) => locked(async () => {
      const entries = await load(globalDir, paths.inbox)
      const key = suggestionFingerprint(input.operation)
      const existing = entries.find((entry) => entry.key === key)
      const replacement = replacementOf(input.operation)
      const entry: CurationSuggestion = {
        key,
        runId: input.runId,
        operationId: input.operation.id,
        kind: input.operation.kind,
        reasonCode: input.operation.reasonCode,
        sources: sortedSources(input.operation.sources),
        destination: replacement === null ? null : { scope: replacement.scope, slug: replacement.slug },
        createdAt: existing?.createdAt ?? input.at,
        updatedAt: input.at,
      }
      const next = [...entries.filter((candidate) => candidate.key !== key), entry]
        .sort((left, right) => left.createdAt - right.createdAt || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
        .slice(-CURATION_SUGGESTION_MAX_ENTRIES)
      await save(globalDir, paths.inbox, next)
      return entry
    }),
    claim: async (limit) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > CURATION_SUGGESTION_CLAIM_MAX) throw new CurationSuggestionClaimLimitError(limit)
      await ensurePrivateDir(globalDir, root)
      return withLock(paths.lock, async () => {
        const entries = await load(globalDir, paths.inbox)
        if (entries.length === 0) return []
        const claimed = entries.slice(0, limit)
        await save(globalDir, paths.inbox, entries.slice(limit))
        return claimed
      }, { retryMs: 0, maxRetries: 1, sleep: async () => undefined })
    },
  }
}
