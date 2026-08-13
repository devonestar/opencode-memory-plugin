import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serializeMemory } from "../src/frontmatter"
import { recoverLifecycleStore } from "../src/lifecycle-recovery"
import { createLifecycleService } from "../src/lifecycle-service"

const ENTRY_ID = "018f47a2-6d87-7d91-9f7e-6c0e40712a41"
const TRANSACTION_ID = "018f47a2-73a0-7eb5-b820-59f79bd57f7b"
const OTHER_ID = "018f47a2-7a22-75c4-9033-71c741ca2620"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-lifecycle-integrity-"))
  const topic = serializeMemory({ name: "alpha", description: "alpha description", type: "project" }, "Durable integrity body.")
  await writeFile(join(root, "alpha.md"), topic)
  await writeFile(join(root, "MEMORY.md"), "- [alpha](alpha.md) — alpha description\n")
  let id = 0
  const archived = await createLifecycleService({
    storeRoot: root,
    scope: "project",
    clock: () => new Date("2026-08-13T12:00:00.000Z"),
    createId: () => [ENTRY_ID, TRANSACTION_ID][id++] ?? crypto.randomUUID(),
  }).archive({ scope: "project", slug: "alpha" })
  if (!archived.ok) throw new TypeError("archive fixture failed")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function rewrite(path: string, change: (value: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("object fixture expected")
  await writeFile(path, `${JSON.stringify(change(Object.fromEntries(Object.entries(parsed))), null, 2)}\n`)
}

describe("lifecycle artifact cross-validation", () => {
  test.each(["archive", "delete", "restore"] as const)("blocks committed %s history when its canonical entry is missing", async (operation) => {
    // Given a committed lifecycle transaction whose corresponding canonical entry is removed
    if (operation === "restore") {
      const restored = await createLifecycleService({ storeRoot: root, scope: "project", createId: () => OTHER_ID })
        .restore({ scope: "project", source: "archive", entryId: ENTRY_ID })
      if (!restored.ok) throw new TypeError("restore fixture failed")
    } else if (operation === "delete") {
      await writeFile(join(root, "beta.md"), serializeMemory({ name: "beta", description: "beta description", type: "project" }, "Durable delete body."))
      await writeFile(join(root, "MEMORY.md"), "- [beta](beta.md) — beta description\n")
      let id = 0
      const deleted = await createLifecycleService({
        storeRoot: root,
        scope: "project",
        createId: () => [OTHER_ID, "018f47a2-80d0-7d65-86c9-265944031f7f"][id++] ?? crypto.randomUUID(),
      }).delete({ scope: "project", slug: "beta" })
      if (!deleted.ok) throw new TypeError("delete fixture failed")
      await rm(join(root, ".user-trash", "entries", deleted.entryId), { recursive: true })
    } else {
      await rm(join(root, ".archive", "entries", ENTRY_ID), { recursive: true })
    }
    if (operation === "restore") await rm(join(root, ".archive", "entries", ENTRY_ID), { recursive: true })

    // When startup recovery validates committed history
    const recovered = await recoverLifecycleStore({ storeRoot: root, scope: "project" })

    // Then canonical absence is corruption, never successful recovery
    expect(recovered).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
  })

  test.each([
    ["intent entry", "transaction", "intent.json", (value: Record<string, unknown>) => ({ ...value, entryId: OTHER_ID })],
    ["record source", "transaction", "record.json", (value: Record<string, unknown>) => ({ ...value, source: "trash" })],
    ["receipt operation", "transaction", "receipt.json", (value: Record<string, unknown>) => ({ ...value, operation: "delete", state: "trashed", source: "trash" })],
    ["entry origin transaction", "entry", "origin.json", (value: Record<string, unknown>) => ({ ...value, transactionId: OTHER_ID })],
    ["entry current transaction", "entry", "state.json", (value: Record<string, unknown>) => ({ ...value, transactionId: OTHER_ID })],
    ["commit receipt digest", "transaction", "committed.json", (value: Record<string, unknown>) => ({ ...value, receiptSha256: "f".repeat(64) })],
  ] as const)("blocks mismatched %s identity", async (_name, parent, file, change) => {
    // Given one committed transaction with a cross-document identity mismatch
    const base = parent === "transaction"
      ? join(root, ".memory-lifecycle", "transactions", TRANSACTION_ID)
      : join(root, ".archive", "entries", ENTRY_ID)
    await rewrite(join(base, file), change)

    // When startup recovery cross-validates the canonical protocol
    const recovered = await recoverLifecycleStore({ storeRoot: root, scope: "project" })

    // Then corruption blocks instead of being treated as absence
    expect(recovered).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
  })

  test("blocks a non-prefix transaction phase order", async () => {
    // Given a committed transaction whose phase history was reordered
    const statePath = join(root, ".memory-lifecycle", "transactions", TRANSACTION_ID, "state.json")
    await rewrite(statePath, (value) => {
      const phases = value["phases"]
      if (!Array.isArray(phases)) throw new TypeError("phase fixture expected")
      return { ...value, phases: phases.toReversed() }
    })

    // When recovery reads the transaction state
    const recovered = await recoverLifecycleStore({ storeRoot: root, scope: "project" })

    // Then invalid phase order is never guessed
    expect(recovered).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
  })

  test("maps a missing requested entry to NOT_FOUND and canonical corruption to RECOVERY_BLOCKED", async () => {
    // Given a healthy archive and a missing entry identifier
    const service = createLifecycleService({ storeRoot: root, scope: "project" })
    const missing = await service.restore({ scope: "project", source: "archive", entryId: OTHER_ID })
    await writeFile(join(root, ".archive", "entries", ENTRY_ID, "topic.md"), "tampered")

    // When the corrupted canonical entry is requested
    const corrupted = await service.restore({ scope: "project", source: "archive", entryId: ENTRY_ID })

    // Then absence and corruption remain distinct sanitized outcomes
    expect(missing).toEqual({ ok: false, code: "NOT_FOUND" })
    expect(corrupted).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
  })
})
