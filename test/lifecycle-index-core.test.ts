import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serializeMemory } from "../src/frontmatter"
import { recoverLifecycleStore } from "../src/lifecycle-recovery"
import { rebuildActiveIndex } from "../src/lifecycle-records-index"
import { createLifecycleService } from "../src/lifecycle-service"

const IDS = [
  "018f47a2-6d87-7d91-9f7e-6c0e40712a41",
  "018f47a2-73a0-7eb5-b820-59f79bd57f7b",
  "018f47a2-7a22-75c4-9033-71c741ca2620",
  "018f47a2-80d0-7d65-86c9-265944031f7f",
] as const

let root: string
let outside: string
let nextId: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-lifecycle-index-"))
  outside = await mkdtemp(join(tmpdir(), "memory-lifecycle-index-outside-"))
  nextId = 0
})

afterEach(async () => {
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
})

function service() {
  return createLifecycleService({
    storeRoot: root,
    scope: "project",
    clock: () => new Date("2026-08-13T12:00:00.000Z"),
    createId: () => IDS[nextId++] ?? crypto.randomUUID(),
  })
}

async function topic(slug: string): Promise<void> {
  const raw = serializeMemory({ name: slug, description: `${slug} description`, type: "project" }, `Durable body for ${slug}.`)
  await writeFile(join(root, `${slug}.md`), raw)
  await writeFile(join(root, "MEMORY.md"), `- [${slug}](${slug}.md) — ${slug} description\n`, { flag: "a" })
}

describe("lifecycle derived indexes", () => {
  test("archive index contains only currently archived entries with stable search metadata", async () => {
    // Given one archived entry, one restored archive entry, and one trash entry
    await topic("kept")
    const kept = await service().archive({ scope: "project", slug: "kept" })
    await topic("restored")
    const restored = await service().archive({ scope: "project", slug: "restored" })
    await topic("trashed")
    const trashed = await service().delete({ scope: "project", slug: "trashed" })
    if (!kept.ok || !restored.ok || !trashed.ok) throw new TypeError("lifecycle fixture failed")

    // When the exact archived entry is restored
    const result = await service().restore({ scope: "project", source: "archive", entryId: restored.entryId })

    // Then archive search exposes only the still-archived stable metadata row
    expect(result.code).toBe("RESTORED")
    const index = JSON.parse(await readFile(join(root, ".archive", "index.json"), "utf8")) as { readonly entries?: readonly Record<string, unknown>[] }
    expect(index.entries).toEqual([{
      entryId: kept.entryId,
      scope: "project",
      slug: "kept",
      type: "project",
      description: "kept description",
      createdAt: "2026-08-13T12:00:00.000Z",
    }])
    expect(JSON.stringify(index)).not.toContain(String(restored.entryId))
    expect(JSON.stringify(index)).not.toContain(String(trashed.entryId))
    expect(JSON.stringify(index)).not.toContain("topicSha256")
    expect(JSON.stringify(index)).not.toContain("topicBytes")
  })

  test.each(["symlink", "malformed", "name-mismatch"] as const)("invalid active %s fails closed without rewriting MEMORY.md", async (condition) => {
    // Given a valid active index and one invalid root-level topic
    const originalIndex = Buffer.from("- [stable](stable.md) — stable description\n")
    await writeFile(join(root, "MEMORY.md"), originalIndex)
    if (condition === "symlink") {
      await writeFile(join(outside, "unsafe.md"), "outside")
      await symlink(join(outside, "unsafe.md"), join(root, "unsafe.md"))
    } else if (condition === "malformed") {
      await writeFile(join(root, "unsafe.md"), "missing frontmatter")
    } else {
      await writeFile(join(root, "unsafe.md"), serializeMemory({ name: "other", description: "wrong name", type: "project" }, "Durable mismatched body."))
    }

    // When active index rebuild validates canonical root topics
    const rebuilding = rebuildActiveIndex(root)

    // Then validation fails before the previous index is replaced
    await expect(rebuilding).rejects.toBeDefined()
    expect(Buffer.compare(await readFile(join(root, "MEMORY.md")), originalIndex)).toBe(0)
  })

  test("invalid sibling active topic returns RECOVERY_BLOCKED through service and preserves the index", async () => {
    // Given one target topic, one malformed sibling, and their prior active index
    await topic("target")
    await writeFile(join(root, "broken.md"), "not a memory")
    const originalIndex = await readFile(join(root, "MEMORY.md"))

    // When lifecycle service attempts to archive the valid target
    const result = await service().archive({ scope: "project", slug: "target" })

    // Then the derived-index failure is sanitized and prior index bytes remain
    expect(result).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
    expect(Buffer.compare(await readFile(join(root, "MEMORY.md")), originalIndex)).toBe(0)
  })

  test("committed transaction receipts remain byte-stable across repeated recovery", async () => {
    // Given a committed archive transaction retained for history
    await topic("historical")
    const archived = await service().archive({ scope: "project", slug: "historical" })
    if (!archived.ok) throw new TypeError("archive fixture failed")
    const transactionRoot = join(root, ".memory-lifecycle", "transactions")
    const transactionId = (await readdir(transactionRoot))[0]
    if (transactionId === undefined) throw new TypeError("transaction fixture missing")
    const receiptPath = join(transactionRoot, transactionId, "receipt.json")
    const journalPath = join(transactionRoot, transactionId, "state.json")
    const receipt = await readFile(receiptPath)
    const journal = await readFile(journalPath)

    // When startup recovery runs twice
    const first = await recoverLifecycleStore({ storeRoot: root, scope: "project" })
    const second = await recoverLifecycleStore({ storeRoot: root, scope: "project" })

    // Then both runs succeed without deleting or rewriting committed history
    expect(first.code).toBe("RECOVERED")
    expect(second.code).toBe("RECOVERED")
    expect(Buffer.compare(await readFile(receiptPath), receipt)).toBe(0)
    expect(Buffer.compare(await readFile(journalPath), journal)).toBe(0)
  })
})
