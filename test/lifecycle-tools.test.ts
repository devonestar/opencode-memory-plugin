import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin"
import { createLifecycleService } from "../src/lifecycle-service"
import { createLifecycleTools, type LifecycleToolRuntime } from "../src/lifecycle-tools"
import { parseEntryId } from "../src/lifecycle-schema"
import { serializeMemory } from "../src/frontmatter"

const ENTRY_ID = "018f47a2-6d87-7d91-9f7e-6c0e40712a41"
const TRANSACTION_ID = "018f47a2-73a0-7eb5-b820-59f79bd57f7b"
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-lifecycle-tools-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function context(ask = async (): Promise<void> => undefined): ToolContext {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "build",
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask,
  }
}

function output(result: ToolResult): Record<string, unknown> {
  const raw = typeof result === "string" ? result : result.output
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("expected JSON object")
  return Object.fromEntries(Object.entries(parsed))
}

async function executeRemoval(
  definition: ReturnType<typeof createLifecycleTools>["memory_archive"] | ReturnType<typeof createLifecycleTools>["memory_delete"],
  args: Readonly<Record<string, unknown>>,
  toolContext = context(),
): Promise<ToolResult> {
  return definition.execute(tool.schema.object(definition.args).parse(args), toolContext)
}

async function executeRestore(
  definition: ReturnType<typeof createLifecycleTools>["memory_restore"],
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  return definition.execute(tool.schema.object(definition.args).parse(args), context())
}

function runtime(classification: "primary" | "child" | "unknown" = "primary"): LifecycleToolRuntime {
  let idIndex = 0
  const service = createLifecycleService({
    storeRoot: root,
    scope: "project",
    createId: () => [ENTRY_ID, TRANSACTION_ID][idIndex++] ?? crypto.randomUUID(),
    clock: () => new Date("2026-08-13T12:00:00.000Z"),
  })
  const unavailableService = createLifecycleService({ storeRoot: join(root, "global"), scope: "global" })
  return {
    classifySession: async () => classification,
    global: { kind: "ready", storeRoot: join(root, "global"), service: unavailableService },
    project: { kind: "ready", storeRoot: root, service },
  }
}

async function seed(slug: string): Promise<void> {
  const topic = serializeMemory({ name: slug, type: "project", description: `${slug} description` }, `Durable ${slug} body.`)
  await writeFile(join(root, `${slug}.md`), topic)
  await writeFile(join(root, "MEMORY.md"), `- [${slug}](${slug}.md) — ${slug} description\n`, { flag: "a" })
}

describe("memory lifecycle tools", () => {
  test("define explicit strict scope, slug, source, and entry id boundaries", () => {
    // Given lifecycle tool schemas
    const tools = createLifecycleTools(runtime())

    // When valid and invalid requests are parsed
    const archive = tool.schema.object(tools.memory_archive.args)
    const restore = tool.schema.object(tools.memory_restore.args)

    // Then no scope defaults, unsafe slugs, extra keys, or non-UUID ids cross the boundary
    expect(archive.safeParse({ scope: "global", slug: "safe-slug" }).success).toBe(true)
    expect(archive.safeParse({ slug: "safe-slug" }).success).toBe(false)
    expect(archive.safeParse({ scope: "all", slug: "safe-slug" }).success).toBe(false)
    expect(archive.safeParse({ scope: "global", slug: "../unsafe" }).success).toBe(false)
    expect(restore.safeParse({ scope: "project", source: "archive", entry_id: ENTRY_ID }).success).toBe(true)
    expect(restore.safeParse({ scope: "project", source: "active", entry_id: ENTRY_ID }).success).toBe(false)
    expect(restore.safeParse({ scope: "project", source: "archive", entry_id: "not-a-uuid" }).success).toBe(false)
  })

  test.each(["child", "unknown"] as const)("rejects %s before service reads and never asks", async (classification) => {
    // Given an unverified session and observable service methods
    let reads = 0
    let asks = 0
    const base = runtime(classification)
    const service = {
      archive: async () => { reads += 1; return { ok: false, code: "ACTIVE_NOT_FOUND" } as const },
      delete: async () => { reads += 1; return { ok: false, code: "ACTIVE_NOT_FOUND" } as const },
      restore: async () => { reads += 1; return { ok: false, code: "NOT_FOUND" } as const },
    }
    const tools = createLifecycleTools({
      ...base,
      global: { kind: "ready", storeRoot: join(root, "global"), service },
      project: { kind: "ready", storeRoot: root, service },
    })

    // When an explicit archive call is executed
    const result = await executeRemoval(tools.memory_archive, { scope: "global", slug: "alpha" }, context(async () => { asks += 1 }))

    // Then authorization fails before any selected service access or confirmation prompt
    expect(output(result)).toEqual({ ok: false, error: "SESSION_NOT_VERIFIED" })
    expect({ reads, asks }).toEqual({ reads: 0, asks: 0 })
  })

  test("uses exact scope with no unavailable-project fallback", async () => {
    // Given an unavailable project and an observable global service
    let globalCalls = 0
    const base = runtime()
    if (base.global.kind !== "ready") throw new TypeError("global fixture unavailable")
    const globalService = { ...base.global.service, archive: async () => { globalCalls += 1; return { ok: false, code: "ACTIVE_NOT_FOUND" } as const } }
    const tools = createLifecycleTools({ ...base, global: { kind: "ready", storeRoot: base.global.storeRoot, service: globalService }, project: { kind: "unavailable" } })

    // When project archive is explicitly requested
    const result = await executeRemoval(tools.memory_archive, { scope: "project", slug: "alpha" })

    // Then project unavailability is stable and global remains untouched
    expect(output(result)).toEqual({ ok: false, error: "PROJECT_UNAVAILABLE" })
    expect(globalCalls).toBe(0)
  })

  test("archives, deletes, and restores through compact metadata-only tool results", async () => {
    // Given two active topics and real exact-scope lifecycle services
    await seed("alpha")
    await seed("discard")
    const tools = createLifecycleTools(runtime())

    // When archive, delete, and exact archive restore are called
    const archived = output(await executeRemoval(tools.memory_archive, { scope: "project", slug: "alpha" }))
    const deleted = output(await executeRemoval(tools.memory_delete, { scope: "project", slug: "discard" }))
    const restored = output(await executeRestore(tools.memory_restore, { scope: "project", source: "archive", entry_id: ENTRY_ID }))

    // Then stable results expose only operation status and approved lifecycle metadata
    expect(archived).toEqual({ ok: true, code: "ARCHIVED", entry_id: ENTRY_ID, slug: "alpha", scope: "project", source: "archive" })
    expect(deleted).toMatchObject({ ok: true, code: "TRASHED", slug: "discard", scope: "project", source: "trash" })
    expect(restored).toEqual({ ok: true, code: "RESTORED", entry_id: ENTRY_ID, slug: "alpha", scope: "project", source: "archive" })
    for (const result of [archived, deleted, restored]) {
      expect(Object.keys(result).sort()).toEqual(["code", "entry_id", "ok", "scope", "slug", "source"])
    }
  })

  test("restore calls only the selected service after authorization", async () => {
    // Given a verified session, no entry artifacts, and an observable lifecycle service
    const calls: string[] = []
    const service = {
      archive: async () => { calls.push("archive"); return { ok: false, code: "ACTIVE_NOT_FOUND" } as const },
      delete: async () => { calls.push("delete"); return { ok: false, code: "ACTIVE_NOT_FOUND" } as const },
      restore: async () => {
        calls.push("restore")
        return { ok: true, code: "RESTORED", entryId: parseEntryId(ENTRY_ID), slug: "alpha" } as const
      },
    }
    const tools = createLifecycleTools({
      classifySession: async () => { calls.push("authorize"); return "primary" },
      global: { kind: "ready", storeRoot: join(root, "global"), service },
      project: { kind: "ready", storeRoot: root, service },
    })

    // When exact restore is requested
    const result = output(await executeRestore(tools.memory_restore, { scope: "project", source: "archive", entry_id: ENTRY_ID }))

    // Then the tool performs authorization and one service restore without pre-reading the filesystem
    expect(calls).toEqual(["authorize", "restore"])
    expect(result).toEqual({ ok: true, code: "RESTORED", entry_id: ENTRY_ID, slug: "alpha", scope: "project", source: "archive" })
  })

  test("blocks only a scope whose startup recovery failed", async () => {
    // Given global recovery blocked while project is ready
    await seed("alpha")
    const base = runtime()
    const tools = createLifecycleTools({ ...base, global: { kind: "blocked" } })

    // When both exact scopes are requested
    const globalResult = output(await executeRemoval(tools.memory_archive, { scope: "global", slug: "alpha" }))
    const projectResult = output(await executeRemoval(tools.memory_archive, { scope: "project", slug: "alpha" }))

    // Then the failed scope is fenced without disabling the healthy scope
    expect(globalResult).toEqual({ ok: false, error: "RECOVERY_BLOCKED" })
    expect(projectResult).toMatchObject({ ok: true, code: "ARCHIVED", scope: "project" })
  })
})
