import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin"
import { createMemoryRecallTool } from "../src/memory-recall"
import type { MemoryScope } from "../src/gate"
import type { MemoryRuntime, ProjectStoreAccess, SessionClassification } from "../src/runtime"
import { createStore, type MemoryStore, type SaveInput } from "../src/store"

type ReadCounts = Record<MemoryScope, number>

let root: string
let stores: Record<MemoryScope, MemoryStore>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-recall-tool-"))
  stores = {
    global: createStore(join(root, "global")),
    project: createStore(join(root, "project")),
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function context(sessionID = "primary-session"): ToolContext {
  return {
    sessionID,
    messageID: "message",
    agent: "build",
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  }
}

function trackedStore(scope: MemoryScope, counts: ReadCounts): MemoryStore {
  const store = stores[scope]
  return {
    ...store,
    readIndexForInjection: async () => {
      counts[scope] += 1
      return store.readIndexForInjection()
    },
  }
}

function runtime(input: {
  readonly classification: SessionClassification
  readonly counts: ReadCounts
  readonly projectStore?: ProjectStoreAccess
  readonly globalStore?: MemoryStore
}): MemoryRuntime {
  return {
    globalStore: { kind: "ready", store: input.globalStore ?? trackedStore("global", input.counts) },
    projectStore: input.projectStore ?? { kind: "ready", store: trackedStore("project", input.counts) },
    classifySession: async () => input.classification,
  }
}

async function seed(scope: MemoryScope, input: SaveInput): Promise<void> {
  await stores[scope].save(input)
}

async function executeRecall(
  definition: ReturnType<typeof createMemoryRecallTool>,
  input: Readonly<Record<string, unknown>>,
  sessionID = "primary-session",
): Promise<ToolResult> {
  const args = tool.schema.object(definition.args).parse(input)
  return definition.execute(args, context(sessionID))
}

function outputOf(result: ToolResult): string {
  return typeof result === "string" ? result : result.output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function jsonOf(result: ToolResult): Record<string, unknown> {
  const parsed: unknown = JSON.parse(outputOf(result))
  if (isRecord(parsed)) return parsed
  throw new TypeError("memory_recall output is not a JSON object")
}

describe("memory_recall", () => {
  test("defines a trimmed, byte-bounded, Unicode-safe schema with closed defaults", () => {
    // Given a recall tool argument boundary
    const definition = createMemoryRecallTool(runtime({ classification: "primary", counts: { global: 0, project: 0 } }))
    const schema = tool.schema.object(definition.args)

    // When representative valid and invalid inputs are parsed
    const defaulted = schema.safeParse({ query: "  기억  " })
    const validBounds = [schema.safeParse({ query: "é".repeat(250), scope: "global", limit: 1 }), schema.safeParse({ query: "a", limit: 10 })]
    const invalid = [
      schema.safeParse({ query: "   " }),
      schema.safeParse({ query: "é".repeat(251) }),
      schema.safeParse({ query: "\uD800" }),
      schema.safeParse({ query: "a", scope: "workspace" }),
      schema.safeParse({ query: "a", limit: 0 }),
      schema.safeParse({ query: "a", limit: 1.5 }),
      schema.safeParse({ query: "a", limit: 11 }),
    ]

    // Then only query, scope, and limit exist with normalized defaults and strict bounds
    expect(Object.keys(definition.args).sort()).toEqual(["limit", "query", "scope"])
    expect(defaulted).toEqual({ success: true, data: { query: "기억", scope: "all", limit: 5 } })
    expect(validBounds.every(({ success }) => success)).toBe(true)
    expect(invalid.every(({ success }) => !success)).toBe(true)
  })

  test.each(["child", "unknown"] as const)("rejects a %s session before any store read", async (classification) => {
    // Given an unverified session and read-counting stores
    const counts = { global: 0, project: 0 }
    const definition = createMemoryRecallTool(runtime({ classification, counts }))

    // When recall is requested
    const result = await executeRecall(definition, { query: "alpha" }, "private-session-id")

    // Then the stable sanitized error is returned without touching either store
    expect(result).toEqual({ title: "memory_recall", output: '{"ok":false,"error":"SESSION_NOT_VERIFIED"}' })
    expect(counts).toEqual({ global: 0, project: 0 })
  })

  test.each(["global", "project", "all"] as const)("isolates reads for %s scope", async (scope) => {
    // Given matching memories in both stores
    await seed("global", { type: "user", slug: "global-alpha", description: "global alpha", body: "Durable global alpha preference for every workspace." })
    await seed("project", { type: "project", slug: "project-alpha", description: "project alpha", body: "Durable project alpha fact for this workspace only." })
    const counts = { global: 0, project: 0 }
    const projectStore: ProjectStoreAccess = scope === "global"
      ? { kind: "unavailable", reason: "/private/project/reason" }
      : { kind: "ready", store: trackedStore("project", counts) }
    const definition = createMemoryRecallTool(runtime({ classification: "primary", counts, projectStore }))

    // When the selected scope is recalled
    const parsed = jsonOf(await executeRecall(definition, { query: "alpha", scope, limit: 10 }))

    // Then only the selected stores contribute reads and results
    const expectedCounts = scope === "global" ? { global: 1, project: 0 } : scope === "project" ? { global: 0, project: 1 } : { global: 1, project: 1 }
    const expectedScopes = scope === "all" ? [{ scope: "global" }, { scope: "project" }] : [{ scope }]
    expect(counts).toEqual(expectedCounts)
    expect(parsed).toMatchObject({ ok: true, scope, matched_count: expectedScopes.length, results: expectedScopes })
  })

  test.each(["project", "all"] as const)("rejects unavailable %s scope without global fallback", async (scope) => {
    // Given no project store and a global store whose reads are observable
    const counts = { global: 0, project: 0 }
    const definition = createMemoryRecallTool(runtime({
      classification: "primary",
      counts,
      projectStore: { kind: "unavailable", reason: `${root}/private-project-token` },
    }))

    // When project-dependent recall is requested
    const result = await executeRecall(definition, { query: "alpha", scope })

    // Then a sanitized project error is returned before any fallback read
    expect(jsonOf(result)).toEqual({ ok: false, error: "PROJECT_UNAVAILABLE" })
    expect(outputOf(result)).not.toContain(root)
    expect(counts).toEqual({ global: 0, project: 0 })
  })

  test("returns Korean-ranked metadata without body, path, hash, or session data", async () => {
    // Given a body-only Korean match containing a private canary
    const bodyCanary = "PRIVATE_BODY_CANARY_9274"
    await seed("global", { type: "reference", slug: "korean-policy", description: "recall policy metadata", body: `장기기억 관리 원칙 ${bodyCanary}` })
    const counts = { global: 0, project: 0 }
    const definition = createMemoryRecallTool(runtime({ classification: "primary", counts }))

    // When a trimmed Korean query is recalled with defaults
    const result = await executeRecall(definition, { query: "  기억  " }, "private-session-canary")
    const parsed = jsonOf(result)
    const results = parsed["results"]
    if (!Array.isArray(results) || results.length !== 1) throw new TypeError("expected one recall result")
    const first: unknown = results[0]
    if (typeof first !== "object" || first === null || Array.isArray(first)) throw new TypeError("expected a metadata result")

    // Then the stable DTO exposes only approved metadata
    expect(result).toHaveProperty("title", "memory_recall")
    expect(Object.keys(parsed).sort()).toEqual(["matched_count", "ok", "query", "result_count", "results", "results_truncated", "scope"])
    expect(Object.keys(first).sort()).toEqual(["description", "scope", "score", "slug", "type"])
    expect(parsed).toMatchObject({ ok: true, query: "기억", scope: "all", matched_count: 1, result_count: 1, results_truncated: false })
    for (const privateValue of [bodyCanary, root, "private-session-canary", '"body"', '"path"', '"hash"', '"sessionID"']) {
      expect(outputOf(result)).not.toContain(privateValue)
    }
  })

  test("applies limit after positive ranking and returns compact bounded JSON", async () => {
    // Given seven positive matches and one zero-score document
    for (let index = 0; index < 7; index += 1) {
      await seed("global", { type: "project", slug: `alpha-${index}`, description: `alpha result ${index}`, body: `Durable alpha result body number ${index}.` })
    }
    await seed("global", { type: "project", slug: "unrelated", description: "unrelated result", body: "Durable beta result body with no matching term." })
    const definition = createMemoryRecallTool(runtime({ classification: "primary", counts: { global: 0, project: 0 } }))

    // When a three-result limit is requested
    const result = await executeRecall(definition, { query: "alpha", scope: "global", limit: 3 })
    const output = outputOf(result)
    const parsed = jsonOf(result)

    // Then counts distinguish all positive matches from returned bounded results
    expect(parsed).toMatchObject({ matched_count: 7, result_count: 3, results_truncated: true })
    expect(parsed["results"]).toHaveLength(3)
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(25_000)
    expect(JSON.stringify(parsed)).toBe(output)
  })

  test("accepts punctuation-only queries with no results", async () => {
    // Given a searchable global memory
    await seed("global", { type: "project", slug: "alpha", description: "alpha result", body: "Durable alpha memory body for punctuation recall." })
    const definition = createMemoryRecallTool(runtime({ classification: "primary", counts: { global: 0, project: 0 } }))

    // When a nonempty tokenless query is recalled
    const parsed = jsonOf(await executeRecall(definition, { query: "... — !!!", scope: "global" }))

    // Then recall succeeds with an empty, untruncated result set
    expect(parsed).toMatchObject({ ok: true, matched_count: 0, result_count: 0, results_truncated: false, results: [] })
  })

  test.each([
    { kind: "incomplete", code: "CORPUS_LIMIT_EXCEEDED" },
    { kind: "unreadable", code: "STORE_UNAVAILABLE" },
  ] as const)("maps $kind corpus failures to sanitized JSON", async ({ kind, code }) => {
    // Given a selected store that reports a bounded typed corpus failure
    const leak = `${root}/MEMORY.md token=private-corpus-token`
    const globalStore: MemoryStore = {
      ...stores.global,
      readIndexForInjection: kind === "incomplete"
        ? async () => ({ content: leak, truncated: true })
        : async () => { throw new TypeError(leak) },
    }
    const definition = createMemoryRecallTool(runtime({ classification: "primary", counts: { global: 0, project: 0 }, globalStore }))

    // When recall loads the failing corpus
    const result = await executeRecall(definition, { query: "alpha", scope: "global" })

    // Then only the closed public error code crosses the tool boundary
    expect(result).toEqual({ title: "memory_recall", output: JSON.stringify({ ok: false, error: code }) })
    expect(outputOf(result)).not.toContain(leak)
  })
})
