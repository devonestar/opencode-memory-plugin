import { tool } from "@opencode-ai/plugin"
import { MEMORY_TYPES, isValidSlug, type MemoryType } from "./frontmatter"
import { isSafeDescription, MEMORY_SCOPES, type MemoryScope } from "./gate"

const z = tool.schema
const uuidSchema = z.string().uuid()
export const entryIdSchema = uuidSchema.brand("EntryId")
export const transactionIdSchema = uuidSchema.brand("TransactionId")
const timestampSchema = z.string().datetime({ offset: true })
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const LIFECYCLE_SOURCES = ["archive", "trash"] as const
export const LIFECYCLE_OPERATIONS = ["archive", "delete", "restore"] as const
export const RECEIPT_STATES = ["archived", "trashed", "restored"] as const
export const JOURNAL_PHASES = ["intent-written", "destination-materialized", "source-removed", "receipt-written", "indexes-written"] as const
export const lifecycleSourceSchema = z.enum(LIFECYCLE_SOURCES)
export const lifecycleOperationSchema = z.enum(LIFECYCLE_OPERATIONS)
export const receiptStateSchema = z.enum(RECEIPT_STATES)
export const journalPhaseSchema = z.enum(JOURNAL_PHASES)

export type EntryId = ReturnType<typeof entryIdSchema.parse>
export type TransactionId = ReturnType<typeof transactionIdSchema.parse>
export type LifecycleSource = (typeof LIFECYCLE_SOURCES)[number]
export type LifecycleOperation = (typeof LIFECYCLE_OPERATIONS)[number]
export type ReceiptState = (typeof RECEIPT_STATES)[number]
export type JournalPhase = (typeof JOURNAL_PHASES)[number]

export type LifecycleRecord = {
  readonly version: 1
  readonly entryId: EntryId
  readonly scope: MemoryScope
  readonly source: LifecycleSource
  readonly slug: string
  readonly type: MemoryType
  readonly description: string
  readonly createdAt: string
  readonly topicSha256: string
  readonly topicBytes: number
}

export type LifecycleIntent =
  | { readonly version: 1; readonly transactionId: TransactionId; readonly entryId: EntryId; readonly operation: "archive"; readonly source: "archive" }
  | { readonly version: 1; readonly transactionId: TransactionId; readonly entryId: EntryId; readonly operation: "delete"; readonly source: "trash" }
  | { readonly version: 1; readonly transactionId: TransactionId; readonly entryId: EntryId; readonly operation: "restore"; readonly source: LifecycleSource }

export type LifecycleReceipt =
  | { readonly version: 1; readonly transactionId: TransactionId; readonly entryId: EntryId; readonly operation: "archive"; readonly state: "archived"; readonly source: "archive"; readonly completedAt: string }
  | { readonly version: 1; readonly transactionId: TransactionId; readonly entryId: EntryId; readonly operation: "delete"; readonly state: "trashed"; readonly source: "trash"; readonly completedAt: string }
  | { readonly version: 1; readonly transactionId: TransactionId; readonly entryId: EntryId; readonly operation: "restore"; readonly state: "restored"; readonly source: LifecycleSource; readonly completedAt: string }

export type LifecycleJournalEntry = { readonly version: 1; readonly transactionId: TransactionId; readonly phase: JournalPhase; readonly at: string }
export type LifecycleTransactionState = { readonly version: 1; readonly transactionId: TransactionId; readonly phases: readonly LifecycleJournalEntry[] }
export type LifecycleCommit = {
  readonly version: 1
  readonly transactionId: TransactionId
  readonly entryId: EntryId
  readonly operation: LifecycleOperation
  readonly source: LifecycleSource
  readonly receiptSha256: string
  readonly committedAt: string
}

export const lifecycleRecordSchema = z.object({
  version: z.literal(1), entryId: entryIdSchema, scope: z.enum(MEMORY_SCOPES), source: lifecycleSourceSchema,
  slug: z.string().refine(isValidSlug, "unsafe slug"), type: z.enum(MEMORY_TYPES),
  description: z.string().min(1).max(200).refine(isSafeDescription, "description must be one safe physical line"),
  createdAt: timestampSchema, topicSha256: digestSchema, topicBytes: z.number().int().nonnegative(),
}).strict()

const intentBase = { version: z.literal(1), transactionId: transactionIdSchema, entryId: entryIdSchema }
export const lifecycleIntentSchema = z.discriminatedUnion("operation", [
  z.object({ ...intentBase, operation: z.literal("archive"), source: z.literal("archive") }).strict(),
  z.object({ ...intentBase, operation: z.literal("delete"), source: z.literal("trash") }).strict(),
  z.object({ ...intentBase, operation: z.literal("restore"), source: lifecycleSourceSchema }).strict(),
])

const receiptBase = { ...intentBase, completedAt: timestampSchema }
export const lifecycleReceiptSchema = z.discriminatedUnion("operation", [
  z.object({ ...receiptBase, operation: z.literal("archive"), state: z.literal("archived"), source: z.literal("archive") }).strict(),
  z.object({ ...receiptBase, operation: z.literal("delete"), state: z.literal("trashed"), source: z.literal("trash") }).strict(),
  z.object({ ...receiptBase, operation: z.literal("restore"), state: z.literal("restored"), source: lifecycleSourceSchema }).strict(),
])

export const lifecycleJournalEntrySchema = z.object({ version: z.literal(1), transactionId: transactionIdSchema, phase: journalPhaseSchema, at: timestampSchema }).strict()
export const lifecycleTransactionStateSchema = z.object({ version: z.literal(1), transactionId: transactionIdSchema, phases: z.array(lifecycleJournalEntrySchema) }).strict()
export const lifecycleCommitSchema = z.object({
  version: z.literal(1), transactionId: transactionIdSchema, entryId: entryIdSchema, operation: lifecycleOperationSchema,
  source: lifecycleSourceSchema, receiptSha256: digestSchema, committedAt: timestampSchema,
}).strict()

export const parseEntryId = (input: unknown): EntryId => entryIdSchema.parse(input)
export const parseTransactionId = (input: unknown): TransactionId => transactionIdSchema.parse(input)
export const parseLifecycleSource = (input: unknown): LifecycleSource => lifecycleSourceSchema.parse(input)
export const parseLifecycleOperation = (input: unknown): LifecycleOperation => lifecycleOperationSchema.parse(input)
export const parseReceiptState = (input: unknown): ReceiptState => receiptStateSchema.parse(input)
export const parseLifecycleRecord = (input: unknown): LifecycleRecord => lifecycleRecordSchema.parse(input)
export const parseLifecycleIntent = (input: unknown): LifecycleIntent => lifecycleIntentSchema.parse(input)
export const parseLifecycleReceipt = (input: unknown): LifecycleReceipt => lifecycleReceiptSchema.parse(input)
export const parseLifecycleJournalEntry = (input: unknown): LifecycleJournalEntry => lifecycleJournalEntrySchema.parse(input)
export const parseLifecycleTransactionState = (input: unknown): LifecycleTransactionState => lifecycleTransactionStateSchema.parse(input)
export const parseLifecycleCommit = (input: unknown): LifecycleCommit => lifecycleCommitSchema.parse(input)
