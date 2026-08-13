import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lifecyclePaths } from "../src/lifecycle-paths"

const ENTRY_ID = "018f47a2-6d87-7d91-9f7e-6c0e40712a41"
const TRANSACTION_ID = "018f47a2-73a0-7eb5-b820-59f79bd57f7b"

let storeRoot: string

beforeEach(async () => {
  storeRoot = await mkdtemp(join(tmpdir(), "memory-lifecycle-paths-"))
})

afterEach(async () => {
  await rm(storeRoot, { recursive: true, force: true })
})

describe("lifecycle paths", () => {
  test("constructs contained per-store namespaces", () => {
    // Given a store and parsed lifecycle identifiers
    // When its lifecycle paths are constructed
    const paths = lifecyclePaths(storeRoot, ENTRY_ID, TRANSACTION_ID)

    // Then each path is rooted in its dedicated private namespace
    expect(paths.archiveEntry).toBe(join(storeRoot, ".archive", "entries", ENTRY_ID))
    expect(paths.userTrashEntry).toBe(join(storeRoot, ".user-trash", "entries", ENTRY_ID))
    expect(paths.transaction).toBe(join(storeRoot, ".memory-lifecycle", "transactions", TRANSACTION_ID))
    expect(paths.archiveIndex).toBe(join(storeRoot, ".archive", "index.json"))
  })

  test("rejects unsafe identifiers before joining paths", () => {
    // Given traversal-shaped lifecycle identifiers
    // When and Then path construction is attempted
    expect(() => lifecyclePaths(storeRoot, "../outside", TRANSACTION_ID)).toThrow()
    expect(() => lifecyclePaths(storeRoot, ENTRY_ID, "../outside")).toThrow()
  })
})
