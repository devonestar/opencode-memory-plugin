import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serializeMemory } from "../src/frontmatter"
import { recoverLifecycleStore } from "../src/lifecycle-recovery"
import { sha256 } from "../src/lifecycle-records-index"
import { parseEntryId, parseTransactionId, type LifecycleRecord } from "../src/lifecycle-schema"
import { createTransactionBundle } from "../src/lifecycle-transaction"

const IDS = [
  "018f47a2-6d87-7d91-9f7e-6c0e40712a41",
  "018f47a2-73a0-7eb5-b820-59f79bd57f7b",
  "018f47a2-7a22-75c4-9033-71c741ca2620",
  "018f47a2-80d0-7d65-86c9-265944031f7f",
] as const
const AT = "2026-08-13T12:00:00.000Z"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-lifecycle-batch-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function stageRemoval(slug: string, operation: "archive" | "delete", entryIndex: 0 | 2): Promise<void> {
  const topic = Buffer.from(serializeMemory({ name: slug, description: `${slug} description`, type: "project" }, `Durable ${slug} body.`))
  const entryId = parseEntryId(IDS[entryIndex])
  const transactionId = parseTransactionId(IDS[entryIndex + 1])
  const source = operation === "archive" ? "archive" : "trash"
  const record: LifecycleRecord = {
    version: 1,
    entryId,
    scope: "project",
    source,
    slug,
    type: "project",
    description: `${slug} description`,
    createdAt: AT,
    topicSha256: sha256(topic),
    topicBytes: topic.byteLength,
  }
  await writeFile(join(root, `${slug}.md`), topic)
  if (operation === "archive") {
    const intent = { version: 1, transactionId, entryId, operation: "archive", source: "archive" } as const
    const receipt = { ...intent, state: "archived", completedAt: AT } as const
    await createTransactionBundle({ storeRoot: root, intent, record, payload: topic, receipt, at: AT })
    return
  }
  const intent = { version: 1, transactionId, entryId, operation: "delete", source: "trash" } as const
  const receipt = { ...intent, state: "trashed", completedAt: AT } as const
  await createTransactionBundle({ storeRoot: root, intent, record, payload: topic, receipt, at: AT })
}

describe("lifecycle recovery batching", () => {
  test("reconciles every incomplete transaction before one final index rebuild and commit", async () => {
    // Given two incomplete removals affecting distinct slugs and canonical sources
    await stageRemoval("alpha", "archive", 0)
    await stageRemoval("beta", "delete", 2)
    await writeFile(join(root, "MEMORY.md"), "stale active index\n")

    // When recovery converges the batch and then runs again
    const first = await recoverLifecycleStore({ storeRoot: root, scope: "project", clock: () => new Date(AT) })
    const activeIndex = await readFile(join(root, "MEMORY.md"), "utf8")
    const archiveIndex = await readFile(join(root, ".archive", "index.json"), "utf8")
    const second = await recoverLifecycleStore({ storeRoot: root, scope: "project", clock: () => new Date(AT) })

    // Then both state transitions are reflected and repeated recovery is byte-stable
    expect(first).toEqual({ ok: true, code: "RECOVERED" })
    await expect(access(join(root, "alpha.md"))).rejects.toBeDefined()
    await expect(access(join(root, "beta.md"))).rejects.toBeDefined()
    expect(activeIndex).toBe("")
    expect(JSON.parse(archiveIndex)).toMatchObject({ entries: [{ entryId: IDS[0], slug: "alpha" }] })
    expect(second).toEqual({ ok: true, code: "RECOVERED" })
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toBe(activeIndex)
    expect(await readFile(join(root, ".archive", "index.json"), "utf8")).toBe(archiveIndex)
  })
})
