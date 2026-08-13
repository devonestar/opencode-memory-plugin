import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serializeMemory } from "../src/frontmatter"
import { recoverLifecycleStore } from "../src/lifecycle-recovery"
import {
  createLifecycleService,
  LIFECYCLE_REMOVAL_CHECKPOINTS,
  LIFECYCLE_RESTORE_CHECKPOINTS,
  LifecycleCrashError,
  type LifecycleCheckpoint,
} from "../src/lifecycle-service"

const ENTRY_ID = "018f47a2-6d87-7d91-9f7e-6c0e40712a41"
const ARCHIVE_TRANSACTION_ID = "018f47a2-73a0-7eb5-b820-59f79bd57f7b"
const RESTORE_TRANSACTION_ID = "018f47a2-7a22-75c4-9033-71c741ca2620"
const NOW = "2026-08-13T12:00:00.000Z"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-lifecycle-crash-boundaries-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function seed(): Promise<Buffer> {
  const topic = Buffer.from(serializeMemory(
    { name: "alpha", description: "alpha description", type: "project" },
    "Durable crash recovery body.\n",
  ))
  await writeFile(join(root, "alpha.md"), topic)
  await writeFile(join(root, "MEMORY.md"), "- [alpha](alpha.md) — alpha description\n")
  return topic
}

function faultAt(phase: LifecycleCheckpoint["phase"]): (checkpoint: LifecycleCheckpoint) => void {
  return (checkpoint) => {
    if (checkpoint.phase === phase) throw new LifecycleCrashError(phase)
  }
}

async function stableFiles(paths: readonly string[]): Promise<void> {
  const before = await Promise.all(paths.map((path) => readFile(path)))
  expect(await recoverLifecycleStore({ storeRoot: root, scope: "project" })).toEqual({ ok: true, code: "RECOVERED" })
  const after = await Promise.all(paths.map((path) => readFile(path)))
  expect(after).toEqual(before)
}

describe("lifecycle persistence crash boundaries", () => {
  test.each([...LIFECYCLE_REMOVAL_CHECKPOINTS])("archive recovery converges after %s", async (phase) => {
    // Given an archive interrupted immediately after one persistence boundary
    const topic = await seed()
    let id = 0
    const service = createLifecycleService({
      storeRoot: root,
      scope: "project",
      clock: () => new Date(NOW),
      createId: () => [ENTRY_ID, ARCHIVE_TRANSACTION_ID][id++] ?? crypto.randomUUID(),
      fault: faultAt(phase),
    })
    await expect(service.archive({ scope: "project", slug: "alpha" })).rejects.toBeInstanceOf(LifecycleCrashError)

    // When a fresh service recovers the store twice
    const first = await recoverLifecycleStore({ storeRoot: root, scope: "project", clock: () => new Date(NOW) })

    // Then an unpublished transaction rolls back, while every published transaction commits exactly once
    expect(first).toEqual({ ok: true, code: "RECOVERED" })
    if (phase.endsWith("-staged") && phase.startsWith("transaction-")) {
      expect(Buffer.compare(await readFile(join(root, "alpha.md")), topic)).toBe(0)
      await expect(access(join(root, ".archive", "entries", ENTRY_ID))).rejects.toBeDefined()
      await stableFiles([join(root, "MEMORY.md"), join(root, ".archive", "index.json")])
      return
    }
    await expect(access(join(root, "alpha.md"))).rejects.toBeDefined()
    expect(Buffer.compare(await readFile(join(root, ".archive", "entries", ENTRY_ID, "topic.md")), topic)).toBe(0)
    const transaction = join(root, ".memory-lifecycle", "transactions", ARCHIVE_TRANSACTION_ID)
    const entry = join(root, ".archive", "entries", ENTRY_ID)
    await stableFiles([
      join(transaction, "receipt.json"),
      join(transaction, "state.json"),
      join(transaction, "committed.json"),
      join(entry, "origin.json"),
      join(entry, "state.json"),
      join(root, "MEMORY.md"),
      join(root, ".archive", "index.json"),
    ])
  })

  test.each([...LIFECYCLE_RESTORE_CHECKPOINTS])("restore recovery converges after %s without replacing origin identity", async (phase) => {
    // Given an archived entry and a restore interrupted after one persistence boundary
    const topic = await seed()
    let archiveId = 0
    const archived = await createLifecycleService({
      storeRoot: root,
      scope: "project",
      clock: () => new Date(NOW),
      createId: () => [ENTRY_ID, ARCHIVE_TRANSACTION_ID][archiveId++] ?? crypto.randomUUID(),
    }).archive({ scope: "project", slug: "alpha" })
    if (!archived.ok) throw new TypeError("archive fixture failed")
    const entry = join(root, ".archive", "entries", ENTRY_ID)
    const origin = await readFile(join(entry, "origin.json"))
    const restoring = createLifecycleService({
      storeRoot: root,
      scope: "project",
      clock: () => new Date(NOW),
      createId: () => RESTORE_TRANSACTION_ID,
      fault: faultAt(phase),
    })
    await expect(restoring.restore({ scope: "project", source: "archive", entryId: ENTRY_ID })).rejects.toBeInstanceOf(LifecycleCrashError)

    // When fresh recovery runs twice
    const first = await recoverLifecycleStore({ storeRoot: root, scope: "project", clock: () => new Date(NOW) })

    // Then pre-publication crashes leave the archive unchanged and published restores preserve immutable origin
    expect(first).toEqual({ ok: true, code: "RECOVERED" })
    if (phase.endsWith("-staged") && phase.startsWith("transaction-")) {
      await expect(access(join(root, "alpha.md"))).rejects.toBeDefined()
      expect(await readFile(join(entry, "origin.json"))).toEqual(origin)
      await stableFiles([join(entry, "origin.json"), join(entry, "state.json"), join(root, "MEMORY.md"), join(root, ".archive", "index.json")])
      return
    }
    expect(Buffer.compare(await readFile(join(root, "alpha.md")), topic)).toBe(0)
    expect(Buffer.compare(await readFile(join(entry, "origin.json")), origin)).toBe(0)
    const state = JSON.parse(await readFile(join(entry, "state.json"), "utf8")) as { readonly transactionId?: unknown; readonly state?: unknown }
    expect(state).toMatchObject({ transactionId: RESTORE_TRANSACTION_ID, state: "restored" })
    const transaction = join(root, ".memory-lifecycle", "transactions", RESTORE_TRANSACTION_ID)
    await stableFiles([
      join(transaction, "receipt.json"),
      join(transaction, "state.json"),
      join(transaction, "committed.json"),
      join(entry, "origin.json"),
      join(entry, "state.json"),
      join(root, "MEMORY.md"),
      join(root, ".archive", "index.json"),
    ])
  })
})
