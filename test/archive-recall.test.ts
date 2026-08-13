import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin"
import { createLifecycleService } from "../src/lifecycle-service"
import { createMemoryRecallArchiveTool } from "../src/memory-recall-archive"
import { createMemoryRecallTool } from "../src/memory-recall"
import { serializeMemory } from "../src/frontmatter"
import { createStore } from "../src/store"
import type { LifecycleToolRuntime } from "../src/lifecycle-tools"

const IDS = [
  "018f47a2-6d87-7d91-9f7e-6c0e40712a41",
  "018f47a2-73a0-7eb5-b820-59f79bd57f7b",
  "018f47a2-7a22-75c4-9033-71c741ca2620",
  "018f47a2-80d0-7d65-86c9-265944031f7f",
] as const
let root: string
let nextId: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-archive-recall-"))
  nextId = 0
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function context(): ToolContext {
  return { sessionID: "primary", messageID: "message", agent: "build", directory: root, worktree: root, abort: new AbortController().signal, metadata: () => undefined, ask: async () => undefined }
}

function runtime(classification: "primary" | "child" | "unknown" = "primary"): LifecycleToolRuntime {
  const projectService = createLifecycleService({
    storeRoot: root,
    scope: "project",
    createId: () => IDS[nextId++] ?? crypto.randomUUID(),
    clock: () => new Date("2026-08-13T12:00:00.000Z"),
  })
  return {
    classifySession: async () => classification,
    global: { kind: "ready", storeRoot: join(root, "global"), service: createLifecycleService({ storeRoot: join(root, "global"), scope: "global" }) },
    project: { kind: "ready", storeRoot: root, service: projectService },
  }
}

async function seed(slug: string, body: string): Promise<void> {
  const raw = serializeMemory({ name: slug, type: "project", description: `${slug} metadata` }, body)
  await writeFile(join(root, `${slug}.md`), raw)
  await writeFile(join(root, "MEMORY.md"), `- [${slug}](${slug}.md) — ${slug} metadata\n`, { flag: "a" })
}

async function execute(definition: ReturnType<typeof createMemoryRecallArchiveTool>, args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
  return definition.execute(tool.schema.object(definition.args).parse(args), context())
}

function json(result: ToolResult): Record<string, unknown> {
  const parsed: unknown = JSON.parse(typeof result === "string" ? result : result.output)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("expected JSON object")
  return Object.fromEntries(Object.entries(parsed))
}

describe("memory_recall_archive", () => {
  test("requires explicit exact scope with the active recall query and limit bounds", () => {
    // Given an archive recall argument boundary
    const definition = createMemoryRecallArchiveTool(runtime())
    const schema = tool.schema.object(definition.args)

    // When valid and invalid inputs are parsed
    const valid = schema.safeParse({ query: "  alpha  ", scope: "project", limit: 10 })
    const invalid = [schema.safeParse({ query: "alpha" }), schema.safeParse({ query: "alpha", scope: "all" }), schema.safeParse({ query: "é".repeat(251), scope: "global" }), schema.safeParse({ query: "alpha", scope: "global", limit: 11 })]

    // Then only an explicit single scope passes and query normalization remains identical
    expect(valid).toEqual({ success: true, data: { query: "alpha", scope: "project", limit: 10 } })
    expect(invalid.every(({ success }) => !success)).toBe(true)
  })

  test.each(["child", "unknown"] as const)("rejects %s before archive reads", async (classification) => {
    // Given an unverified session and a missing archive store
    const definition = createMemoryRecallArchiveTool(runtime(classification))

    // When archive recall is called
    const result = await execute(definition, { query: "alpha", scope: "project" })

    // Then authorization wins over any filesystem failure
    expect(json(result)).toEqual({ ok: false, error: "SESSION_NOT_VERIFIED" })
  })

  test("returns RECOVERY_BLOCKED before archive filesystem access", async () => {
    // Given a blocked project scope whose root is an observable invalid path
    const blocked = { ...runtime(), project: { kind: "blocked" } } as const

    // When exact project archive recall is requested
    const result = await execute(createMemoryRecallArchiveTool(blocked), { query: "alpha", scope: "project" })

    // Then the startup recovery classification wins before corpus loading
    expect(json(result)).toEqual({ ok: false, error: "RECOVERY_BLOCKED" })
  })

  test("ranks archived body content but returns metadata only and leaves active recall isolated", async () => {
    // Given one archived body-only match and one still-active match
    const secret = "PRIVATE_ARCHIVE_BODY_CANARY"
    await seed("archived", `Durable nebula policy ${secret}.`)
    await seed("active", "Durable nebula active policy.")
    const lifecycle = runtime()
    if (lifecycle.project.kind !== "ready") throw new TypeError("project fixture unavailable")
    const archived = await lifecycle.project.service.archive({ scope: "project", slug: "archived" })
    if (!archived.ok) throw new TypeError("archive fixture failed")
    const archiveTool = createMemoryRecallArchiveTool(lifecycle)
    const activeTool = createMemoryRecallTool({ globalStore: { kind: "ready", store: createStore(join(root, "global")) }, projectStore: { kind: "ready", store: createStore(root) }, classifySession: async () => "primary" })

    // When both recall surfaces search the same term
    const archivedOutput = json(await execute(archiveTool, { query: "nebula", scope: "project" }))
    const activeOutput = json(await activeTool.execute(tool.schema.object(activeTool.args).parse({ query: "nebula", scope: "project" }), context()))

    // Then each surface sees only its own corpus and archive output contains no private content
    expect(archivedOutput).toMatchObject({ ok: true, matched_count: 1, results: [{ entry_id: archived.entryId, slug: "archived", scope: "project", archived_at: "2026-08-13T12:00:00.000Z" }] })
    expect(activeOutput).toMatchObject({ ok: true, matched_count: 1, results: [{ slug: "active" }] })
    const result = JSON.stringify(archivedOutput)
    expect(result).not.toContain(secret)
    expect(result).not.toContain("body")
    expect(result).not.toContain("path")
    expect(result).not.toContain("hash")
  })

  test("excludes restored archive entries and never searches user or curation trash", async () => {
    // Given one restored archive entry plus matching user-trash and curation-trash payloads
    await seed("restored", "Durable comet archive body.")
    await seed("deleted", "Durable comet user trash body.")
    const lifecycle = runtime()
    if (lifecycle.project.kind !== "ready") throw new TypeError("project fixture unavailable")
    const archived = await lifecycle.project.service.archive({ scope: "project", slug: "restored" })
    const deleted = await lifecycle.project.service.delete({ scope: "project", slug: "deleted" })
    if (!archived.ok || !deleted.ok) throw new TypeError("lifecycle fixture failed")
    await lifecycle.project.service.restore({ scope: "project", source: "archive", entryId: archived.entryId })
    await mkdir(join(root, ".trash"), { recursive: true })
    await writeFile(join(root, ".trash", "curation-canary.md"), "comet")

    // When explicit archive recall searches the shared term
    const result = json(await execute(createMemoryRecallArchiveTool(lifecycle), { query: "comet", scope: "project" }))

    // Then no restored, user-trash, or curation-trash artifact is searchable
    expect(result).toMatchObject({ ok: true, matched_count: 0, results: [] })
  })

  test.each(["malformed", "tampered"] as const)("fails closed for a %s canonical archive", async (kind) => {
    // Given one archived entry whose index or canonical topic is corrupted
    await seed("alpha", "Durable alpha archive body.")
    const lifecycle = runtime()
    if (lifecycle.project.kind !== "ready") throw new TypeError("project fixture unavailable")
    const archived = await lifecycle.project.service.archive({ scope: "project", slug: "alpha" })
    if (!archived.ok) throw new TypeError("archive fixture failed")
    if (kind === "malformed") await writeFile(join(root, ".archive", "index.json"), "{not-json")
    else {
      const topicPath = join(root, ".archive", "entries", archived.entryId, "topic.md")
      await writeFile(topicPath, `${await readFile(topicPath, "utf8")}tampered`)
    }

    // When archive recall loads the selected corpus
    const result = json(await execute(createMemoryRecallArchiveTool(lifecycle), { query: "alpha", scope: "project" }))

    // Then malformed and tampered state share one sanitized closed failure
    expect(result).toEqual({ ok: false, error: "STORE_UNAVAILABLE" })
  })

  test("fails closed when one canonical archived topic exceeds 32 KiB", async () => {
    // Given an archived entry whose canonical topic exceeds the per-topic bound
    await seed("oversized", "bounded archive fixture")
    const lifecycle = runtime()
    if (lifecycle.project.kind !== "ready") throw new TypeError("project fixture unavailable")
    const archived = await lifecycle.project.service.archive({ scope: "project", slug: "oversized" })
    if (!archived.ok) throw new TypeError("archive fixture failed")
    await truncate(join(root, ".archive", "entries", archived.entryId, "topic.md"), 33 * 1024)

    // When archive recall loads the selected corpus
    const result = json(await execute(createMemoryRecallArchiveTool(lifecycle), { query: "oversized", scope: "project" }))

    // Then no partial corpus is searched
    expect(result).toEqual({ ok: false, error: "CORPUS_LIMIT_EXCEEDED" })
  })
})
