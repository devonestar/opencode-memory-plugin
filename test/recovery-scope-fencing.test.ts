import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import { createMemoryRecallTool } from "../src/memory-recall"
import { MEMORY_BLOCK_SENTINEL } from "../src/prompt"
import { createMemorySaveTool, injectMemoryForSession, type MemoryRuntime } from "../src/runtime"
import { createStore, type MemoryStore } from "../src/store"

type Counts = { reads: number; duplicateChecks: number; writes: number }

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-recovery-fence-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function context(): ToolContext {
  return {
    sessionID: "primary", messageID: "message", agent: "build", directory: root, worktree: root,
    abort: new AbortController().signal, metadata: () => undefined, ask: async () => undefined,
  }
}

function countedStore(scope: "global" | "project", counts: Counts): MemoryStore {
  const store = createStore(join(root, scope))
  return {
    ...store,
    readIndexForInjection: async () => { counts.reads += 1; return store.readIndexForInjection() },
    hasSlug: async (slug) => { counts.duplicateChecks += 1; return store.hasSlug(slug) },
    save: async (input) => { counts.writes += 1; return store.save(input) },
  }
}

function runtime(globalStore: MemoryRuntime["globalStore"], projectStore: MemoryRuntime["projectStore"]): MemoryRuntime {
  return { globalStore, projectStore, classifySession: async () => "primary" }
}

function json(result: ToolResult): Record<string, unknown> {
  const parsed: unknown = JSON.parse(typeof result === "string" ? result : result.output)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("expected JSON object")
  return Object.fromEntries(Object.entries(parsed))
}

describe("recovery-blocked scope fencing", () => {
  test("global recovery blocking prevents injection before either store read", async () => {
    // Given a blocked global scope and a healthy observable project scope
    const projectCounts = { reads: 0, duplicateChecks: 0, writes: 0 }
    const system = ["base prompt"]

    // When session injection runs
    await injectMemoryForSession(runtime({ kind: "blocked" }, { kind: "ready", store: countedStore("project", projectCounts) }), "primary", system)

    // Then global-read failure safety suppresses the whole memory block without project access
    expect(system).toEqual(["base prompt"])
    expect(projectCounts).toEqual({ reads: 0, duplicateChecks: 0, writes: 0 })
  })

  test("project recovery blocking injects only the healthy global scope", async () => {
    // Given one healthy global pointer and a blocked project scope
    const globalCounts = { reads: 0, duplicateChecks: 0, writes: 0 }
    const global = countedStore("global", globalCounts)
    await global.save({ type: "user", slug: "healthy-global", description: "healthy global pointer", body: "Durable healthy global memory." })
    globalCounts.writes = 0
    const system: string[] = []

    // When injection runs
    await injectMemoryForSession(runtime({ kind: "ready", store: global }, { kind: "blocked" }), "primary", system)

    // Then a memory block is injected without touching project storage
    expect(system[0]?.split("\n", 1)[0]).toBe(MEMORY_BLOCK_SENTINEL)
    expect(globalCounts).toEqual({ reads: 1, duplicateChecks: 0, writes: 0 })
  })

  test.each(["global", "project"] as const)("save rejects blocked %s before any store access", async (scope) => {
    // Given one blocked selected scope and one healthy observable peer
    const healthyScope = scope === "global" ? "project" : "global"
    const counts = { reads: 0, duplicateChecks: 0, writes: 0 }
    const healthy = { kind: "ready", store: countedStore(healthyScope, counts) } as const
    const memoryRuntime = scope === "global" ? runtime({ kind: "blocked" }, healthy) : runtime(healthy, { kind: "blocked" })

    // When save explicitly selects the blocked scope
    const result = await createMemorySaveTool(memoryRuntime).execute(
      { scope, type: "project", slug: "blocked-save", description: "blocked save attempt", body: "This write must never reach either store." },
      context(),
    )

    // Then the stable recovery error wins before duplicate checks or writes
    expect(result).toHaveProperty("output", "RECOVERY_BLOCKED")
    expect(counts).toEqual({ reads: 0, duplicateChecks: 0, writes: 0 })
  })

  test("healthy save skips cross-scope duplicate inspection when the peer is blocked", async () => {
    // Given a ready global store and blocked project store
    const counts = { reads: 0, duplicateChecks: 0, writes: 0 }
    const memoryRuntime = runtime({ kind: "ready", store: countedStore("global", counts) }, { kind: "blocked" })

    // When a global save is requested
    const result = await createMemorySaveTool(memoryRuntime).execute(
      { scope: "global", type: "reference", slug: "healthy-save", description: "healthy exact scope save", body: "The healthy scope remains writable." },
      context(),
    )

    // Then only the selected store is written
    expect(result).toHaveProperty("title", "memory saved: healthy-save")
    expect(counts).toEqual({ reads: 0, duplicateChecks: 0, writes: 1 })
  })

  test.each(["global", "project", "all"] as const)("normal recall returns RECOVERY_BLOCKED for selected blocked %s scope before reads", async (scope) => {
    // Given global blocked for global/all, or project blocked for project
    const counts = { reads: 0, duplicateChecks: 0, writes: 0 }
    const readyGlobal = { kind: "ready", store: countedStore("global", counts) } as const
    const readyProject = { kind: "ready", store: countedStore("project", counts) } as const
    const memoryRuntime = scope === "project" ? runtime(readyGlobal, { kind: "blocked" }) : runtime({ kind: "blocked" }, readyProject)
    const recall = createMemoryRecallTool(memoryRuntime)

    // When recall selects a set containing the blocked scope
    const result = await recall.execute({ query: "alpha", scope, limit: 5 }, context())

    // Then no healthy peer fallback or partial read occurs
    expect(json(result)).toEqual({ ok: false, error: "RECOVERY_BLOCKED" })
    expect(counts).toEqual({ reads: 0, duplicateChecks: 0, writes: 0 })
  })
})
