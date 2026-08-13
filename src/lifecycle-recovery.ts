import { rm } from "node:fs/promises"
import { join } from "node:path"
import type { MemoryScope } from "./gate"
import { removeStagedBundle } from "./lifecycle-bundle"
import type { LifecycleFault } from "./lifecycle-checkpoints"
import { parseEntryId, parseTransactionId, type LifecycleReceipt, type TransactionId } from "./lifecycle-schema"
import { materializePrivateBytesExclusive } from "./private-file-move"
import { ensurePrivateRoot, verifyRegularPrivateFile } from "./private-fs"
import { listPrivateDirectory, readPrivateBytesBounded } from "./private-contained"
import { LIFECYCLE_DIRECTORY_LIMIT, LIFECYCLE_TOPIC_MAX_BYTES } from "./lifecycle-limits"
import {
  LifecycleIntegrityError,
  entryRoot,
  materializeEntryBundle,
  readEntry,
  rebuildActiveIndex,
  rebuildArchiveIndex,
  sha256,
  writeEntryState,
} from "./lifecycle-records-index"
import { appendPhase, commitTransaction, readCommittedTransaction, readTransaction, type CommittedTransaction, type TransactionArtifacts } from "./lifecycle-transaction"

export type LifecycleRecoveryResult = { readonly ok: true; readonly code: "RECOVERED" } | { readonly ok: false; readonly code: "RECOVERY_BLOCKED" }

type RecoveryInput = {
  readonly storeRoot: string
  readonly scope: MemoryScope
  readonly clock?: () => Date
  readonly fault?: LifecycleFault
}

async function regular(root: string, path: string): Promise<boolean> {
  try {
    await verifyRegularPrivateFile(root, path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

const now = (input: RecoveryInput): string => (input.clock ?? (() => new Date()))().toISOString()

async function phase(input: RecoveryInput, artifacts: TransactionArtifacts, name: Parameters<typeof appendPhase>[2], checkpoint: Parameters<NonNullable<RecoveryInput["fault"]>>[0]["phase"]): Promise<TransactionArtifacts> {
  const next = await appendPhase(input.storeRoot, artifacts, name, now(input))
  await input.fault?.({ phase: checkpoint })
  return next
}

async function reconcileRemoval(input: RecoveryInput, initial: TransactionArtifacts): Promise<TransactionArtifacts> {
  let artifacts = initial
  const active = join(input.storeRoot, `${artifacts.record.slug}.md`)
  const root = entryRoot(input.storeRoot, artifacts.record.source, artifacts.record.entryId)
  if (artifacts.state.phases.length === 1) {
    try {
      const entry = await readEntry(input.storeRoot, artifacts.record.source, artifacts.record.entryId)
      if (entry.origin.transactionId !== artifacts.intent.transactionId) throw new LifecycleIntegrityError("entry origin transaction mismatch")
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        if (artifacts.receipt.operation === "restore") throw new LifecycleIntegrityError("removal receipt mismatch")
        await materializeEntryBundle({ storeRoot: input.storeRoot, record: artifacts.record, topic: artifacts.payload, origin: artifacts.receipt, ...(input.fault === undefined ? {} : { fault: input.fault }) })
      } else throw error
    }
    artifacts = await phase(input, artifacts, "destination-materialized", "transaction-destination-state")
  }
  const entry = await readEntry(input.storeRoot, artifacts.record.source, artifacts.record.entryId)
  if (entry.origin.transactionId !== artifacts.intent.transactionId || entry.origin.operation !== artifacts.intent.operation) throw new LifecycleIntegrityError("entry origin mismatch")
  if (artifacts.state.phases.length === 2) {
    if (await regular(input.storeRoot, active)) {
      const activeBytes = (await readPrivateBytesBounded(input.storeRoot, active, LIFECYCLE_TOPIC_MAX_BYTES)).bytes
      if (sha256(activeBytes) !== artifacts.record.topicSha256) throw new LifecycleIntegrityError("active topic changed after intent")
      await rm(active)
      await input.fault?.({ phase: "active-removed" })
    }
    artifacts = await phase(input, artifacts, "source-removed", "transaction-source-state")
  }
  if (artifacts.state.phases.length === 3) {
    await writeEntryState(input.storeRoot, artifacts.record, artifacts.receipt)
    await input.fault?.({ phase: "entry-current-state" })
    artifacts = await phase(input, artifacts, "receipt-written", "transaction-receipt-state")
  }
  await verifyRegularPrivateFile(input.storeRoot, join(root, "origin.json"))
  return artifacts
}

async function reconcileRestore(input: RecoveryInput, initial: TransactionArtifacts): Promise<TransactionArtifacts> {
  let artifacts = initial
  const entry = await readEntry(input.storeRoot, artifacts.record.source, artifacts.record.entryId)
  if (entry.record.scope !== input.scope || entry.record.topicSha256 !== artifacts.record.topicSha256 || entry.record.topicBytes !== artifacts.record.topicBytes || !entry.topic.equals(artifacts.payload)) throw new LifecycleIntegrityError("restore origin mismatch")
  const active = join(input.storeRoot, `${entry.record.slug}.md`)
  if (artifacts.state.phases.length === 1) artifacts = await phase(input, artifacts, "destination-materialized", "transaction-destination-state")
  if (artifacts.state.phases.length === 2) {
    if (await regular(input.storeRoot, active)) {
      const activeBytes = (await readPrivateBytesBounded(input.storeRoot, active, LIFECYCLE_TOPIC_MAX_BYTES)).bytes
      if (sha256(activeBytes) !== entry.record.topicSha256) throw new LifecycleIntegrityError("restore destination collision")
    } else {
      const created = await materializePrivateBytesExclusive(input.storeRoot, active, entry.topic)
      if (!created) throw new LifecycleIntegrityError("restore destination collision")
      await input.fault?.({ phase: "active-materialized" })
    }
    artifacts = await phase(input, artifacts, "source-removed", "transaction-source-state")
  }
  if (artifacts.state.phases.length === 3) {
    await writeEntryState(input.storeRoot, entry.record, artifacts.receipt)
    await input.fault?.({ phase: "entry-current-state" })
    artifacts = await phase(input, artifacts, "receipt-written", "transaction-receipt-state")
  }
  const current = await readEntry(input.storeRoot, artifacts.record.source, artifacts.record.entryId)
  if (JSON.stringify(current.state) !== JSON.stringify(artifacts.receipt)) throw new LifecycleIntegrityError("entry state mismatch")
  return artifacts
}

async function finalize(input: RecoveryInput, initial: TransactionArtifacts): Promise<void> {
  let artifacts = initial
  if (artifacts.state.phases.length === 4) {
    artifacts = await phase(input, artifacts, "indexes-written", "transaction-indexes-state")
  }
  if (artifacts.commit === undefined) {
    artifacts = await commitTransaction(input.storeRoot, artifacts, now(input))
    await input.fault?.({ phase: "committed-marker" })
  }
  if (artifacts.commit === undefined) throw new LifecycleIntegrityError("transaction commit missing")
}

async function reconcileOne(input: RecoveryInput, transactionId: TransactionId): Promise<TransactionArtifacts> {
  const artifacts = await readTransaction(input.storeRoot, transactionId)
  if (artifacts.record.scope !== input.scope) throw new LifecycleIntegrityError("transaction scope mismatch")
  switch (artifacts.intent.operation) {
    case "archive":
    case "delete":
      return reconcileRemoval(input, artifacts)
    case "restore":
      return reconcileRestore(input, artifacts)
  }
}

async function validateCommittedEntry(storeRoot: string, scope: MemoryScope, transaction: CommittedTransaction): Promise<void> {
  if (transaction.record.scope !== scope) throw new LifecycleIntegrityError("transaction scope mismatch")
  const entry = await readEntry(storeRoot, transaction.record.source, transaction.record.entryId)
  if (JSON.stringify(entry.record) !== JSON.stringify(transaction.record)) throw new LifecycleIntegrityError("transaction entry record mismatch")
  switch (transaction.intent.operation) {
    case "archive":
    case "delete":
      if (JSON.stringify(entry.origin) !== JSON.stringify(transaction.receipt)) throw new LifecycleIntegrityError("transaction entry origin mismatch")
      return
    case "restore":
      if (JSON.stringify(entry.state) !== JSON.stringify(transaction.receipt)) throw new LifecycleIntegrityError("transaction entry state mismatch")
      return
  }
}

async function cleanupStaging(storeRoot: string): Promise<void> {
  const stagingRoot = join(storeRoot, ".memory-lifecycle", "staging")
  let names: readonly string[]
  try {
    names = await listPrivateDirectory(storeRoot, stagingRoot, LIFECYCLE_DIRECTORY_LIMIT)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
  for (const name of names) {
    const id = name.startsWith("transaction-") ? name.slice("transaction-".length) : name.startsWith("entry-") ? name.slice("entry-".length) : undefined
    if (id === undefined) throw new LifecycleIntegrityError("unknown staging artifact")
    if (name.startsWith("transaction-")) parseTransactionId(id)
    else parseEntryId(id)
    await removeStagedBundle(storeRoot, join(stagingRoot, name))
  }
}

async function validateCurrentStates(storeRoot: string): Promise<void> {
  for (const source of ["archive", "trash"] as const) {
    const entriesRoot = join(storeRoot, source === "archive" ? ".archive" : ".user-trash", "entries")
    let ids: readonly string[]
    try {
      ids = await listPrivateDirectory(storeRoot, entriesRoot, LIFECYCLE_DIRECTORY_LIMIT)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      throw error
    }
    for (const id of ids) {
      const entry = await readEntry(storeRoot, source, parseEntryId(id))
      const [originTransaction, stateTransaction] = await Promise.all([
        readCommittedTransaction(storeRoot, entry.origin.transactionId),
        readCommittedTransaction(storeRoot, entry.state.transactionId),
      ])
      if (originTransaction === undefined || JSON.stringify(originTransaction.receipt) !== JSON.stringify(entry.origin)) {
        throw new LifecycleIntegrityError("entry origin transaction mismatch")
      }
      if (stateTransaction === undefined || JSON.stringify(stateTransaction.receipt) !== JSON.stringify(entry.state)) {
        throw new LifecycleIntegrityError("entry current state transaction mismatch")
      }
    }
  }
}

export async function recoverLifecycleStore(input: RecoveryInput): Promise<LifecycleRecoveryResult> {
  try {
    await ensurePrivateRoot(input.storeRoot)
    await cleanupStaging(input.storeRoot)
    const transactionDir = join(input.storeRoot, ".memory-lifecycle", "transactions")
    let ids: readonly string[]
    try {
      ids = await listPrivateDirectory(input.storeRoot, transactionDir, LIFECYCLE_DIRECTORY_LIMIT)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") ids = []
      else throw error
    }
    const incomplete: TransactionArtifacts[] = []
    const committed: CommittedTransaction[] = []
    for (const id of ids) {
      const transactionId = parseTransactionId(id)
      const completed = await readCommittedTransaction(input.storeRoot, transactionId)
      if (completed === undefined) incomplete.push(await reconcileOne(input, transactionId))
      else committed.push(completed)
    }
    const activeIndex = join(input.storeRoot, "MEMORY.md")
    const archiveIndex = join(input.storeRoot, ".archive", "index.json")
    const indexesExist = await regular(input.storeRoot, activeIndex) && await regular(input.storeRoot, archiveIndex)
    if (incomplete.length > 0 || !indexesExist) {
      await rebuildActiveIndex(input.storeRoot)
      await input.fault?.({ phase: "active-index" })
      await rebuildArchiveIndex(input.storeRoot)
      await input.fault?.({ phase: "archive-index" })
    }
    for (const artifacts of incomplete) await finalize(input, artifacts)
    for (const transaction of committed) await validateCommittedEntry(input.storeRoot, input.scope, transaction)
    await validateCurrentStates(input.storeRoot)
    return { ok: true, code: "RECOVERED" }
  } catch (error) {
    if (error instanceof Error && error.name === "LifecycleCrashError") throw error
    if (error instanceof Error) return { ok: false, code: "RECOVERY_BLOCKED" }
    throw error
  }
}
