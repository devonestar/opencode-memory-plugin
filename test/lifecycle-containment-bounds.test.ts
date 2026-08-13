import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin"
import { serializeMemory } from "../src/frontmatter"
import { recoverLifecycleStore } from "../src/lifecycle-recovery"
import { createLifecycleService } from "../src/lifecycle-service"
import { createMemoryRecallArchiveTool } from "../src/memory-recall-archive"
import type { LifecycleToolRuntime } from "../src/lifecycle-tools"

const ENTRY_ID = "018f47a2-6d87-7d91-9f7e-6c0e40712a41"
const TRANSACTION_ID = "018f47a2-73a0-7eb5-b820-59f79bd57f7b"
const JSON_LIMIT = 64 * 1024

let root: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-lifecycle-bounds-"))
  outside = await mkdtemp(join(tmpdir(), "memory-lifecycle-canary-"))
})

afterEach(async () => {
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
})

async function seed(): Promise<void> {
  await writeFile(join(root, "alpha.md"), serializeMemory({ name: "alpha", type: "project", description: "alpha metadata" }, "Durable canary body."))
  await writeFile(join(root, "MEMORY.md"), "- [alpha](alpha.md) — alpha metadata\n")
}

function lifecycle() {
  let nextId = 0
  return createLifecycleService({
    storeRoot: root,
    scope: "project",
    createId: () => [ENTRY_ID, TRANSACTION_ID][nextId++] ?? crypto.randomUUID(),
    clock: () => new Date("2026-08-13T12:00:00.000Z"),
  })
}

function context(): ToolContext {
  return { sessionID: "primary", messageID: "message", agent: "build", directory: root, worktree: root, abort: new AbortController().signal, metadata: () => undefined, ask: async () => undefined }
}

async function recall(runtime: LifecycleToolRuntime): Promise<Record<string, unknown>> {
  const definition = createMemoryRecallArchiveTool(runtime)
  const result: ToolResult = await definition.execute(tool.schema.object(definition.args).parse({ query: "canary", scope: "project" }), context())
  const parsed: unknown = JSON.parse(typeof result === "string" ? result : result.output)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("expected recall object")
  return Object.fromEntries(Object.entries(parsed))
}

describe("lifecycle containment and bounds", () => {
  test("archive recall rejects an archive parent replaced by a symlink", async () => {
    // Given a valid archive moved outside and linked back beneath the store
    await seed()
    const service = lifecycle()
    const archived = await service.archive({ scope: "project", slug: "alpha" })
    if (!archived.ok) throw new TypeError("archive fixture failed")
    const externalArchive = join(outside, "archive")
    await rename(join(root, ".archive"), externalArchive)
    await symlink(externalArchive, join(root, ".archive"))
    const runtime: LifecycleToolRuntime = {
      classifySession: async () => "primary",
      global: { kind: "ready", storeRoot: join(root, "global"), service: createLifecycleService({ storeRoot: join(root, "global"), scope: "global" }) },
      project: { kind: "ready", storeRoot: root, service },
    }

    // When archive recall traverses the replaced parent
    const result = await recall(runtime)

    // Then it fails closed instead of reading the external archive
    expect(result).toEqual({ ok: false, error: "STORE_UNAVAILABLE" })
    expect(await readFile(join(externalArchive, "entries", archived.entryId, "topic.md"), "utf8")).toContain("Durable canary body.")
  })

  test("recovery rejects an oversized sparse transaction JSON file", async () => {
    // Given committed history with an intent expanded beyond the JSON bound
    await seed()
    const archived = await lifecycle().archive({ scope: "project", slug: "alpha" })
    if (!archived.ok) throw new TypeError("archive fixture failed")
    const intent = join(root, ".memory-lifecycle", "transactions", TRANSACTION_ID, "intent.json")
    await truncate(intent, JSON_LIMIT + 1)

    // When startup recovery reads retained history
    const recovered = await recoverLifecycleStore({ storeRoot: root, scope: "project" })

    // Then bounded validation blocks the store without touching the external namespace
    expect(recovered).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
    await expect(access(join(outside, "canary"))).rejects.toBeDefined()
  })

  test("recovery rejects more than 1000 transaction directories before reading them", async () => {
    // Given a lifecycle transaction namespace above its total-history bound
    const transactions = join(root, ".memory-lifecycle", "transactions")
    await mkdir(transactions, { recursive: true, mode: 0o700 })
    for (let index = 0; index <= 1_000; index += 1) {
      const id = `00000000-0000-7000-8000-${index.toString().padStart(12, "0")}`
      await mkdir(join(transactions, id), { mode: 0o700 })
    }
    const canary = join(transactions, "00000000-0000-7000-8000-000000000000", "intent.json")
    const handle = await open(canary, "w", 0o600)
    await handle.truncate(8 * 1024 * 1024 * 1024)
    await handle.close()

    // When recovery enumerates retained transaction history
    const recovered = await recoverLifecycleStore({ storeRoot: root, scope: "project" })

    // Then it blocks at the directory count and does not read the sparse canary
    expect(recovered).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
    expect((await stat(canary)).size).toBe(8 * 1024 * 1024 * 1024)
  })

  test.each([
    ["lifecycle root", ".memory-lifecycle"],
    ["staging", join(".memory-lifecycle", "staging")],
    ["archive root", ".archive"],
    ["archive entries", join(".archive", "entries")],
    ["trash root", ".user-trash"],
    ["trash entries", join(".user-trash", "entries")],
    ["transactions", join(".memory-lifecycle", "transactions")],
  ] as const)("recovery rejects a symlinked %s parent without reading its canary", async (_label, relativeParent) => {
    // Given one lifecycle directory redirected to an external canary namespace
    const parent = join(root, relativeParent)
    await mkdir(join(parent, "placeholder"), { recursive: true, mode: 0o700 })
    await rm(parent, { recursive: true })
    await writeFile(join(outside, "canary"), "EXTERNAL_CANARY")
    await symlink(outside, parent)

    // When startup recovery traverses lifecycle directories
    const recovered = await recoverLifecycleStore({ storeRoot: root, scope: "project" })

    // Then containment blocks and the external canary remains unchanged
    expect(recovered).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
    expect(await readFile(join(outside, "canary"), "utf8")).toBe("EXTERNAL_CANARY")
  })

  test.each([
    ["staging", join(".memory-lifecycle", "staging"), "transaction-00000000-0000-7000-8000-"],
    ["archive entries", join(".archive", "entries"), "00000000-0000-7000-8000-"],
    ["trash entries", join(".user-trash", "entries"), "00000000-0000-7000-8000-"],
  ] as const)("recovery rejects more than 1000 %s", async (_label, relativeParent, prefix) => {
    // Given a lifecycle directory containing 1001 validly named children
    const parent = join(root, relativeParent)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    for (let index = 0; index <= 1_000; index += 1) {
      await mkdir(join(parent, `${prefix}${index.toString().padStart(12, "0")}`), { mode: 0o700 })
    }

    // When recovery enumerates the directory
    const recovered = await recoverLifecycleStore({ storeRoot: root, scope: "project" })

    // Then it blocks before processing any child
    expect(recovered).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
    await expect(access(join(parent, `${prefix}000000000000`))).resolves.toBeNull()
  })

  test("committed-only recovery leaves derived indexes untouched", async () => {
    // Given one fully committed transaction and stable derived indexes
    await seed()
    const archived = await lifecycle().archive({ scope: "project", slug: "alpha" })
    if (!archived.ok) throw new TypeError("archive fixture failed")
    const activeBefore = await stat(join(root, "MEMORY.md"))
    const archiveBefore = await stat(join(root, ".archive", "index.json"))

    // When startup recovery validates completed history
    const recovered = await recoverLifecycleStore({ storeRoot: root, scope: "project" })
    const activeAfter = await stat(join(root, "MEMORY.md"))
    const archiveAfter = await stat(join(root, ".archive", "index.json"))

    // Then validation succeeds without rebuilding either index
    expect(recovered).toEqual({ ok: true, code: "RECOVERED" })
    expect(activeAfter.ino).toBe(activeBefore.ino)
    expect(archiveAfter.ino).toBe(archiveBefore.ino)
  })
})
