import { describe, expect, test } from "bun:test"
import {
  parseEntryId,
  parseLifecycleIntent,
  parseLifecycleJournalEntry,
  parseLifecycleOperation,
  parseLifecycleReceipt,
  parseLifecycleRecord,
  parseLifecycleSource,
  parseReceiptState,
  parseTransactionId,
} from "../src/lifecycle-schema"

const ENTRY_ID = "018f47a2-6d87-7d91-9f7e-6c0e40712a41"
const TRANSACTION_ID = "018f47a2-73a0-7eb5-b820-59f79bd57f7b"
const RECORD = {
  version: 1,
  entryId: ENTRY_ID,
  scope: "project",
  source: "archive",
  slug: "safe-topic",
  type: "project",
  description: "A safe durable topic description",
  createdAt: "2026-08-13T12:00:00.000Z",
  topicSha256: "a".repeat(64),
  topicBytes: 42,
}

describe("lifecycle schemas", () => {
  test("parses UUID entry and transaction identifiers", () => {
    // Given UUID identifiers
    // When they cross the lifecycle boundary
    const entryId = parseEntryId(ENTRY_ID)
    const transactionId = parseTransactionId(TRANSACTION_ID)

    // Then both retain their exact values
    expect(String(entryId)).toBe(ENTRY_ID)
    expect(String(transactionId)).toBe(TRANSACTION_ID)
  })

  test("rejects traversal-shaped identifiers before path construction", () => {
    // Given identifiers that could escape a namespace
    const unsafeIds = ["../outside", `${ENTRY_ID}/outside`, "..%2Foutside"]

    // When and Then each identifier is parsed
    for (const unsafeId of unsafeIds) expect(() => parseEntryId(unsafeId)).toThrow()
  })

  test("parses only supported lifecycle literals", () => {
    // Given supported source, operation, and receipt state literals
    // When they cross their schema boundaries
    const source = parseLifecycleSource("trash")
    const operation = parseLifecycleOperation("delete")
    const state = parseReceiptState("trashed")

    // Then supported literals remain exact and unsupported literals fail
    expect(source).toBe("trash")
    expect(operation).toBe("delete")
    expect(state).toBe("trashed")
    expect(() => parseLifecycleSource(".trash")).toThrow()
    expect(() => parseLifecycleOperation("move")).toThrow()
    expect(() => parseReceiptState("deleted")).toThrow()
  })

  test("returns exact path-independent immutable record metadata", () => {
    // Given restore metadata independent of transaction and filesystem paths
    // When the persisted record crosses the schema boundary
    const parsed = parseLifecycleRecord(RECORD)

    // Then the exact typed metadata is retained
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(RECORD))
  })

  test("rejects path and transaction coupling as unknown record keys", () => {
    // Given otherwise valid immutable records with mutable-operation coupling
    const unsafeRecords = [
      { ...RECORD, originalPath: "topic.md" },
      { ...RECORD, path: "/outside/topic.md" },
      { ...RECORD, transactionId: TRANSACTION_ID },
      { ...RECORD, unexpected: true },
    ]

    // When and Then each record crosses the strict persisted-data boundary
    for (const record of unsafeRecords) expect(() => parseLifecycleRecord(record)).toThrow()
  })

  test("rejects unsafe immutable restore identity metadata", () => {
    // Given invalid slug, description, type, and scope variants
    const unsafeRecords = [
      { ...RECORD, slug: "../outside" },
      { ...RECORD, description: "two\nlines" },
      { ...RECORD, description: "x".repeat(201) },
      { ...RECORD, type: "unknown" },
      { ...RECORD, scope: "local" },
    ]

    // When and Then each record is parsed
    for (const record of unsafeRecords) expect(() => parseLifecycleRecord(record)).toThrow()
  })

  test("constrains restore intents to archive or trash sources", () => {
    // Given a restore intent with each supported source
    const base = { version: 1, transactionId: TRANSACTION_ID, entryId: ENTRY_ID, operation: "restore" }

    // When both intents are parsed
    const archive = parseLifecycleIntent({ ...base, source: "archive" })
    const trash = parseLifecycleIntent({ ...base, source: "trash" })

    // Then the source remains part of the typed intent
    expect(archive.operation).toBe("restore")
    expect(trash.operation).toBe("restore")
    if (archive.operation !== "restore" || trash.operation !== "restore") throw new TypeError("restore intent expected")
    expect(archive.source).toBe("archive")
    expect(trash.source).toBe("trash")
  })

  test("requires operation-specific source fields on archive and delete intents", () => {
    // Given operations with their canonical destination sources
    const base = { version: 1, transactionId: TRANSACTION_ID, entryId: ENTRY_ID }

    // When and Then matching sources parse while missing or crossed sources fail
    expect(parseLifecycleIntent({ ...base, operation: "archive", source: "archive" }).source).toBe("archive")
    expect(parseLifecycleIntent({ ...base, operation: "delete", source: "trash" }).source).toBe("trash")
    expect(() => parseLifecycleIntent({ ...base, operation: "archive" })).toThrow()
    expect(() => parseLifecycleIntent({ ...base, operation: "delete", source: "archive" })).toThrow()
  })

  test("enforces operation-specific receipt states", () => {
    // Given receipt metadata shared by every operation
    const base = { version: 1, transactionId: TRANSACTION_ID, entryId: ENTRY_ID, completedAt: "2026-08-13T12:00:00.000Z" }

    // When and Then matching operation states parse while mismatches fail
    expect(parseLifecycleReceipt({ ...base, operation: "archive", state: "archived", source: "archive" }).state).toBe("archived")
    expect(parseLifecycleReceipt({ ...base, operation: "delete", state: "trashed", source: "trash" }).state).toBe("trashed")
    expect(parseLifecycleReceipt({ ...base, operation: "restore", state: "restored", source: "trash" }).state).toBe("restored")
    expect(() => parseLifecycleReceipt({ ...base, operation: "delete", state: "archived" })).toThrow()
  })

  test("rejects unknown intent and receipt keys", () => {
    // Given valid lifecycle documents with extra input
    const intent = { version: 1, transactionId: TRANSACTION_ID, entryId: ENTRY_ID, operation: "archive", extra: true }
    const receipt = { version: 1, transactionId: TRANSACTION_ID, entryId: ENTRY_ID, operation: "archive", state: "archived", completedAt: "2026-08-13T12:00:00.000Z", extra: true }

    // When and Then strict parsing rejects both documents
    expect(() => parseLifecycleIntent(intent)).toThrow()
    expect(() => parseLifecycleReceipt(receipt)).toThrow()
  })

  test("constrains strict journal entries to lifecycle phases", () => {
    // Given a journal entry at the intent boundary
    const entry = { version: 1, transactionId: TRANSACTION_ID, phase: "intent-written", at: "2026-08-13T12:00:00.000Z" }

    // When the entry is parsed
    const parsed = parseLifecycleJournalEntry(entry)

    // Then its phase is retained and unsupported shapes are rejected
    expect(parsed.phase).toBe("intent-written")
    expect(() => parseLifecycleJournalEntry({ ...entry, phase: "unknown" })).toThrow()
    expect(() => parseLifecycleJournalEntry({ ...entry, extra: true })).toThrow()
  })
})
