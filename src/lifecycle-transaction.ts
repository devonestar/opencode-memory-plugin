import { join } from "node:path"
import type { LifecycleFault } from "./lifecycle-checkpoints"
import type {
  LifecycleCommit,
  LifecycleIntent,
  LifecycleJournalEntry,
  LifecycleReceipt,
  LifecycleRecord,
  LifecycleTransactionState,
  TransactionId,
} from "./lifecycle-schema"
import {
  JOURNAL_PHASES,
  parseLifecycleCommit,
  parseLifecycleIntent,
  parseLifecycleReceipt,
  parseLifecycleRecord,
  parseLifecycleTransactionState,
} from "./lifecycle-schema"
import { LifecycleIntegrityError, sha256 } from "./lifecycle-records-index"
import { LIFECYCLE_JSON_MAX_BYTES, LIFECYCLE_TOPIC_MAX_BYTES } from "./lifecycle-limits"
import { stageAndPublishBundle } from "./lifecycle-bundle"
import { materializePrivateBytesExclusive, replacePrivateBytesAtomic } from "./private-file-move"
import { readPrivateBytesBounded } from "./private-contained"

export type TransactionArtifacts = {
  readonly intent: LifecycleIntent
  readonly record: LifecycleRecord
  readonly payload: Buffer
  readonly receipt: LifecycleReceipt
  readonly state: LifecycleTransactionState
  readonly commit?: LifecycleCommit
}

export type CommittedTransaction = {
  readonly intent: LifecycleIntent
  readonly record: LifecycleRecord
  readonly receipt: LifecycleReceipt
  readonly state: LifecycleTransactionState
  readonly commit: LifecycleCommit
}

export const transactionRoot = (storeRoot: string, transactionId: TransactionId): string => join(storeRoot, ".memory-lifecycle", "transactions", transactionId)
export const transactionStagingRoot = (storeRoot: string, transactionId: TransactionId): string => join(storeRoot, ".memory-lifecycle", "staging", `transaction-${transactionId}`)
const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

export async function createTransactionBundle(input: {
  readonly storeRoot: string
  readonly intent: LifecycleIntent
  readonly record: LifecycleRecord
  readonly payload: Uint8Array
  readonly receipt: LifecycleReceipt
  readonly at: string
  readonly fault?: LifecycleFault
}): Promise<void> {
  const state: LifecycleTransactionState = {
    version: 1,
    transactionId: input.intent.transactionId,
    phases: [{ version: 1, transactionId: input.intent.transactionId, phase: "intent-written", at: input.at }],
  }
  await stageAndPublishBundle({
    storeRoot: input.storeRoot,
    stagingRoot: transactionStagingRoot(input.storeRoot, input.intent.transactionId),
    destinationRoot: transactionRoot(input.storeRoot, input.intent.transactionId),
    files: [
      { name: "intent.json", bytes: jsonBytes(input.intent), checkpoint: "transaction-intent-staged" },
      { name: "record.json", bytes: jsonBytes(input.record), checkpoint: "transaction-record-staged" },
      { name: "payload.md", bytes: input.payload, checkpoint: "transaction-payload-staged" },
      { name: "receipt.json", bytes: jsonBytes(input.receipt), checkpoint: "transaction-receipt-staged" },
      { name: "state.json", bytes: jsonBytes(state), checkpoint: "transaction-state-staged" },
    ],
    publishedCheckpoint: "transaction-published",
    ...(input.fault === undefined ? {} : { fault: input.fault }),
  })
}

export async function appendPhase(storeRoot: string, artifacts: TransactionArtifacts, phase: LifecycleJournalEntry["phase"], at: string): Promise<TransactionArtifacts> {
  const expected = JOURNAL_PHASES[artifacts.state.phases.length]
  if (phase !== expected) throw new LifecycleIntegrityError("transaction phase transition mismatch")
  const state: LifecycleTransactionState = {
    version: 1,
    transactionId: artifacts.intent.transactionId,
    phases: [...artifacts.state.phases, { version: 1, transactionId: artifacts.intent.transactionId, phase, at }],
  }
  await replacePrivateBytesAtomic(storeRoot, join(transactionRoot(storeRoot, artifacts.intent.transactionId), "state.json"), jsonBytes(state))
  return { ...artifacts, state }
}

export async function commitTransaction(storeRoot: string, artifacts: TransactionArtifacts, at: string): Promise<TransactionArtifacts> {
  const commit: LifecycleCommit = {
    version: 1,
    transactionId: artifacts.intent.transactionId,
    entryId: artifacts.intent.entryId,
    operation: artifacts.intent.operation,
    source: artifacts.intent.source,
    receiptSha256: sha256(jsonBytes(artifacts.receipt)),
    committedAt: at,
  }
  const created = await materializePrivateBytesExclusive(storeRoot, join(transactionRoot(storeRoot, artifacts.intent.transactionId), "committed.json"), jsonBytes(commit))
  if (!created) throw new LifecycleIntegrityError("transaction commit marker already exists")
  return { ...artifacts, commit }
}

async function json(storeRoot: string, path: string): Promise<unknown> {
  try {
    return JSON.parse((await readPrivateBytesBounded(storeRoot, path, LIFECYCLE_JSON_MAX_BYTES)).bytes.toString("utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) throw new LifecycleIntegrityError("transaction JSON is malformed")
    throw error
  }
}

async function optionalCommit(storeRoot: string, path: string): Promise<LifecycleCommit | undefined> {
  try {
    return parseLifecycleCommit(await json(storeRoot, path))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

export async function readTransaction(storeRoot: string, transactionId: TransactionId): Promise<TransactionArtifacts> {
  const root = transactionRoot(storeRoot, transactionId)
  const intent = parseLifecycleIntent(await json(storeRoot, join(root, "intent.json")))
  const record = parseLifecycleRecord(await json(storeRoot, join(root, "record.json")))
  const payload = (await readPrivateBytesBounded(storeRoot, join(root, "payload.md"), LIFECYCLE_TOPIC_MAX_BYTES)).bytes
  const receipt = parseLifecycleReceipt(await json(storeRoot, join(root, "receipt.json")))
  const state = parseLifecycleTransactionState(await json(storeRoot, join(root, "state.json")))
  const commit = await optionalCommit(storeRoot, join(root, "committed.json"))
  validateTransaction(transactionId, { intent, record, payload, receipt, state, ...(commit === undefined ? {} : { commit }) })
  return { intent, record, payload, receipt, state, ...(commit === undefined ? {} : { commit }) }
}

export async function readCommittedTransaction(storeRoot: string, transactionId: TransactionId): Promise<CommittedTransaction | undefined> {
  const root = transactionRoot(storeRoot, transactionId)
  const commit = await optionalCommit(storeRoot, join(root, "committed.json"))
  if (commit === undefined) return undefined
  const intent = parseLifecycleIntent(await json(storeRoot, join(root, "intent.json")))
  const record = parseLifecycleRecord(await json(storeRoot, join(root, "record.json")))
  const receipt = parseLifecycleReceipt(await json(storeRoot, join(root, "receipt.json")))
  const state = parseLifecycleTransactionState(await json(storeRoot, join(root, "state.json")))
  validateCommittedTransaction(transactionId, { intent, record, receipt, state, commit })
  return { intent, record, receipt, state, commit }
}

function validateCommittedTransaction(transactionId: TransactionId, artifacts: CommittedTransaction): void {
  const phases = artifacts.state.phases
  const identities = [artifacts.intent.transactionId, artifacts.receipt.transactionId, artifacts.state.transactionId, ...phases.map(({ transactionId: id }) => id)]
  if (identities.some((id) => id !== transactionId)) throw new LifecycleIntegrityError("transaction identity mismatch")
  if (artifacts.intent.entryId !== artifacts.record.entryId || artifacts.receipt.entryId !== artifacts.record.entryId) throw new LifecycleIntegrityError("transaction entry mismatch")
  if (artifacts.intent.operation !== artifacts.receipt.operation || artifacts.intent.source !== artifacts.record.source || artifacts.intent.source !== artifacts.receipt.source) throw new LifecycleIntegrityError("transaction operation mismatch")
  if (phases.length !== JOURNAL_PHASES.length || phases.some((entry, index) => entry.phase !== JOURNAL_PHASES[index])) throw new LifecycleIntegrityError("transaction phase order mismatch")
  const commit = artifacts.commit
  if (commit.transactionId !== transactionId || commit.entryId !== artifacts.record.entryId || commit.operation !== artifacts.intent.operation || commit.source !== artifacts.intent.source || commit.receiptSha256 !== sha256(jsonBytes(artifacts.receipt))) throw new LifecycleIntegrityError("transaction commit mismatch")
}

function validateTransaction(transactionId: TransactionId, artifacts: TransactionArtifacts): void {
  const phases = artifacts.state.phases
  const identities = [artifacts.intent.transactionId, artifacts.receipt.transactionId, artifacts.state.transactionId, ...phases.map(({ transactionId: id }) => id)]
  if (identities.some((id) => id !== transactionId)) throw new LifecycleIntegrityError("transaction identity mismatch")
  if (artifacts.intent.entryId !== artifacts.record.entryId || artifacts.receipt.entryId !== artifacts.record.entryId) throw new LifecycleIntegrityError("transaction entry mismatch")
  if (artifacts.intent.operation !== artifacts.receipt.operation || artifacts.intent.source !== artifacts.record.source || artifacts.intent.source !== artifacts.receipt.source) throw new LifecycleIntegrityError("transaction operation mismatch")
  if (sha256(artifacts.payload) !== artifacts.record.topicSha256 || artifacts.payload.byteLength !== artifacts.record.topicBytes) throw new LifecycleIntegrityError("transaction payload mismatch")
  if (phases.length === 0 || phases.some((entry, index) => entry.phase !== JOURNAL_PHASES[index])) throw new LifecycleIntegrityError("transaction phase order mismatch")
  if (artifacts.commit !== undefined) {
    validateCommittedTransaction(transactionId, { intent: artifacts.intent, record: artifacts.record, receipt: artifacts.receipt, state: artifacts.state, commit: artifacts.commit })
  }
}
