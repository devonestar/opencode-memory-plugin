import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { INDEX_FILENAME } from "./config"
import { withLock } from "./fsutil"
import { isValidSlug, parseMemory } from "./frontmatter"
import type { MemoryScope } from "./gate"
import {
  LIFECYCLE_REMOVAL_CHECKPOINTS,
  LIFECYCLE_RESTORE_CHECKPOINTS,
  type LifecycleCheckpoint,
  type LifecycleFault,
} from "./lifecycle-checkpoints"
import { recoverLifecycleStore } from "./lifecycle-recovery"
import {
  parseEntryId,
  parseLifecycleSource,
  parseTransactionId,
  type EntryId,
  type LifecycleIntent,
  type LifecycleReceipt,
  type LifecycleRecord,
  type LifecycleSource,
} from "./lifecycle-schema"
import { verifyRegularPrivateFile } from "./private-fs"
import { readPrivateBytesBounded } from "./private-contained"
import { LIFECYCLE_TOPIC_MAX_BYTES } from "./lifecycle-limits"
import { readEntry, sha256, validateActiveTopics } from "./lifecycle-records-index"
import { createTransactionBundle } from "./lifecycle-transaction"

export { LIFECYCLE_REMOVAL_CHECKPOINTS, LIFECYCLE_RESTORE_CHECKPOINTS }
export type { LifecycleCheckpoint }

export class LifecycleCrashError extends Error {
  readonly name = "LifecycleCrashError"
  constructor(readonly checkpoint: string) { super(`simulated lifecycle crash after ${checkpoint}`) }
}

type LifecycleFailure = { readonly ok: false; readonly code: "ACTIVE_NOT_FOUND" | "ACTIVE_COLLISION" | "NOT_FOUND" | "ALREADY_RESTORED" | "RECOVERY_BLOCKED" }
export type LifecycleRemovalResult = { readonly ok: true; readonly code: "ARCHIVED" | "TRASHED"; readonly entryId: EntryId } | LifecycleFailure
export type LifecycleRestoreResult = { readonly ok: true; readonly code: "RESTORED"; readonly entryId: EntryId; readonly slug: string } | LifecycleFailure
export type LifecycleResult = LifecycleRemovalResult | LifecycleRestoreResult

type ServiceInput = {
  readonly storeRoot: string
  readonly scope: MemoryScope
  readonly clock?: () => Date
  readonly createId?: () => string
  readonly fault?: LifecycleFault
}

type MutationInput = { readonly scope: MemoryScope; readonly slug: string }
type RestoreInput = { readonly scope: MemoryScope; readonly source: LifecycleSource; readonly entryId: unknown }

async function regular(root: string, path: string): Promise<boolean> {
  try {
    await verifyRegularPrivateFile(root, path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

const isAbsent = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT"

export function createLifecycleService(input: ServiceInput) {
  const clock = input.clock ?? (() => new Date())
  const createId = input.createId ?? randomUUID
  const locked = <T>(work: () => Promise<T>) => withLock(join(input.storeRoot, `${INDEX_FILENAME}.lock`), work)
  const checkpoint = async (phase: LifecycleCheckpoint["phase"]): Promise<void> => input.fault?.({ phase })

  const remove = async (request: MutationInput, operation: "archive" | "delete"): Promise<LifecycleRemovalResult> => locked(async () => {
    const recovered = await recoverLifecycleStore({ storeRoot: input.storeRoot, scope: input.scope, clock })
    if (!recovered.ok) return recovered
    if (request.scope !== input.scope || !isValidSlug(request.slug)) return { ok: false, code: "ACTIVE_NOT_FOUND" }
    const active = join(input.storeRoot, `${request.slug}.md`)
    try {
      if (!(await regular(input.storeRoot, active))) return { ok: false, code: "ACTIVE_NOT_FOUND" }
      await validateActiveTopics(input.storeRoot)
      const topic = (await readPrivateBytesBounded(input.storeRoot, active, LIFECYCLE_TOPIC_MAX_BYTES)).bytes
      const parsed = parseMemory(topic.toString("utf8"))
      if (parsed.frontmatter.name !== request.slug) return { ok: false, code: "RECOVERY_BLOCKED" }
      const entryId = parseEntryId(createId())
      const transactionId = parseTransactionId(createId())
      const source = operation === "archive" ? "archive" : "trash"
      const at = clock().toISOString()
      const record: LifecycleRecord = {
        version: 1, entryId, scope: input.scope, source, slug: request.slug, type: parsed.frontmatter.type,
        description: parsed.frontmatter.description, createdAt: at, topicSha256: sha256(topic), topicBytes: topic.byteLength,
      }
      const intent: LifecycleIntent = operation === "archive"
        ? { version: 1, transactionId, entryId, operation: "archive", source: "archive" }
        : { version: 1, transactionId, entryId, operation: "delete", source: "trash" }
      const receipt: LifecycleReceipt = operation === "archive"
        ? { version: 1, transactionId, entryId, operation: "archive", state: "archived", source: "archive", completedAt: at }
        : { version: 1, transactionId, entryId, operation: "delete", state: "trashed", source: "trash", completedAt: at }
      await createTransactionBundle({ storeRoot: input.storeRoot, intent, record, payload: topic, receipt, at, ...(input.fault === undefined ? {} : { fault: input.fault }) })
      await checkpoint("intent")
      const converged = await recoverLifecycleStore({ storeRoot: input.storeRoot, scope: input.scope, clock, fault: async (point) => {
        await input.fault?.(point)
        if (point.phase === "entry-published") await checkpoint("payload")
        if (point.phase === "active-removed") await checkpoint("source")
        if (point.phase === "entry-current-state") await checkpoint("receipt")
        if (point.phase === "transaction-indexes-state") await checkpoint("index")
      } })
      return converged.ok ? { ok: true, code: operation === "archive" ? "ARCHIVED" : "TRASHED", entryId } : converged
    } catch (error) {
      if (error instanceof LifecycleCrashError) throw error
      return { ok: false, code: "RECOVERY_BLOCKED" }
    }
  })

  const restore = async (request: RestoreInput): Promise<LifecycleRestoreResult> => locked(async () => {
    const recovered = await recoverLifecycleStore({ storeRoot: input.storeRoot, scope: input.scope, clock })
    if (!recovered.ok) return recovered
    if (request.scope !== input.scope) return { ok: false, code: "NOT_FOUND" }
    let entryId: EntryId
    let source: LifecycleSource
    try {
      entryId = parseEntryId(request.entryId)
      source = parseLifecycleSource(request.source)
    } catch (error) {
      if (error instanceof Error) return { ok: false, code: "NOT_FOUND" }
      throw error
    }
    let entry: Awaited<ReturnType<typeof readEntry>>
    try {
      entry = await readEntry(input.storeRoot, source, entryId)
    } catch (error) {
      if (isAbsent(error)) return { ok: false, code: "NOT_FOUND" }
      if (error instanceof Error) return { ok: false, code: "RECOVERY_BLOCKED" }
      throw error
    }
    if (entry.record.scope !== input.scope) return { ok: false, code: "NOT_FOUND" }
    if (entry.state.state === "restored") return { ok: false, code: "ALREADY_RESTORED" }
    const active = join(input.storeRoot, `${entry.record.slug}.md`)
    try {
      if (await regular(input.storeRoot, active)) return { ok: false, code: "ACTIVE_COLLISION" }
      const transactionId = parseTransactionId(createId())
      const at = clock().toISOString()
      const intent = { version: 1, transactionId, entryId, operation: "restore", source } as const
      const receipt = { version: 1, transactionId, entryId, operation: "restore", state: "restored", source, completedAt: at } as const
      await createTransactionBundle({ storeRoot: input.storeRoot, intent, record: entry.record, payload: entry.topic, receipt, at, ...(input.fault === undefined ? {} : { fault: input.fault }) })
      await checkpoint("intent")
      const converged = await recoverLifecycleStore({ storeRoot: input.storeRoot, scope: input.scope, clock, fault: async (point) => {
        await input.fault?.(point)
        if (point.phase === "active-materialized") await checkpoint("payload")
        if (point.phase === "transaction-source-state") await checkpoint("source")
        if (point.phase === "entry-current-state") await checkpoint("receipt")
        if (point.phase === "transaction-indexes-state") await checkpoint("index")
      } })
      return converged.ok ? { ok: true, code: "RESTORED", entryId, slug: entry.record.slug } : converged
    } catch (error) {
      if (error instanceof LifecycleCrashError) throw error
      return { ok: false, code: "RECOVERY_BLOCKED" }
    }
  })

  return { archive: (request: MutationInput) => remove(request, "archive"), delete: (request: MutationInput) => remove(request, "delete"), restore }
}
