import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { MEMORY_BLOCK_SENTINEL } from "../src/prompt"
import { createMemorySaveTool, createSessionClassifier, injectMemoryForSession } from "../src/runtime"
import { createStore } from "../src/store"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-plugin-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function toolContext(sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: "message",
    agent: "primary",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  }
}

describe("memory_save scope", () => {
  test("requires an explicit scope in its argument schema", () => {
    const memorySave = createMemorySaveTool({
      globalStore: { kind: "ready", store: createStore(join(dir, "global")) },
      projectStore: { kind: "ready", store: createStore(join(dir, "project")) },
      classifySession: async () => "primary",
    })
    expect(memorySave.args.scope.safeParse(undefined).success).toBe(false)
  })

  test.each(["first\nsecond", "first\rsecond", "first\0second", "escape ``` fence"]) (
    "rejects an unsafe description at the tool schema boundary: %p",
    (description) => {
      const memorySave = createMemorySaveTool({
        globalStore: { kind: "ready", store: createStore(join(dir, "global")) },
        projectStore: { kind: "ready", store: createStore(join(dir, "project")) },
        classifySession: async () => "primary",
      })
      expect(memorySave.args.description.safeParse(description).success).toBe(false)
    },
  )

  test("rejects project scope when the project store is unavailable", async () => {
    // Given a primary session whose project namespace could not be resolved
    const globalDir = join(dir, "global")
    const memorySave = createMemorySaveTool({
      globalStore: { kind: "ready", store: createStore(globalDir) },
      projectStore: { kind: "unavailable", reason: "worktree cannot be resolved" },
      classifySession: async () => "primary",
    })

    // When project storage is requested
    const result = await memorySave.execute(
      { scope: "project", type: "project", slug: "product-fact", description: "product-specific fact", body: "This durable fact applies only to the current product." },
      toolContext("primary"),
    )

    // Then the write is rejected rather than falling back to global memory
    expect(result).toHaveProperty("title", "memory_save rejected")
    await expect(access(join(globalDir, "product-fact.md"))).rejects.toBeDefined()
  })

  test("rejects a slug already stored in the other scope", async () => {
    // Given a slug already persisted for this project
    const globalDir = join(dir, "global")
    const projectStore = createStore(join(dir, "project"))
    await projectStore.save({ type: "project", slug: "shared-fact", description: "project-owned fact", body: "This existing durable fact belongs to project memory." })
    const memorySave = createMemorySaveTool({
      globalStore: { kind: "ready", store: createStore(globalDir) },
      projectStore: { kind: "ready", store: projectStore },
      classifySession: async () => "primary",
    })

    // When the same slug is requested globally
    const result = await memorySave.execute(
      { scope: "global", type: "reference", slug: "shared-fact", description: "duplicate global fact", body: "This duplicate must update the existing project memory." },
      toolContext("primary"),
    )

    // Then the cross-scope duplicate is rejected
    expect(result).toHaveProperty("title", "memory_save rejected")
    await expect(access(join(globalDir, "shared-fact.md"))).rejects.toBeDefined()
  })

  test("routes an explicit project save only to the project store", async () => {
    // Given available stores and a verified primary session
    const globalDir = join(dir, "global")
    const projectDir = join(dir, "project")
    const memorySave = createMemorySaveTool({
      globalStore: { kind: "ready", store: createStore(globalDir) },
      projectStore: { kind: "ready", store: createStore(projectDir) },
      classifySession: async () => "primary",
    })

    // When the tool saves to project scope
    await memorySave.execute(
      { scope: "project", type: "reference", slug: "project-reference", description: "project-specific system", body: "This reference applies only to the current project." },
      toolContext("primary"),
    )

    // Then only the project store receives the topic
    await expect(access(join(projectDir, "project-reference.md"))).resolves.toBeNull()
    await expect(access(join(globalDir, "project-reference.md"))).rejects.toBeDefined()
  })
})

describe("memory injection", () => {
  test("injects global pointers with an empty project section when the project store is unavailable", async () => {
    // Given a readable global store and an unavailable project namespace
    const globalStore = createStore(join(dir, "global"))
    await globalStore.save({
      type: "user",
      slug: "global-preference",
      description: "global preference",
      body: "This durable preference applies across all workspaces.",
    })
    const system: string[] = []

    // When memory injection runs for a primary session
    await injectMemoryForSession(
      {
        globalStore: { kind: "ready", store: globalStore },
        projectStore: { kind: "unavailable", reason: "worktree cannot be resolved" },
        classifySession: async () => "primary",
      },
      "primary",
      system,
    )

    // Then global data is injected and the missing project index is rendered empty
    expect(system[0]).toContain("](global-preference.md)")
    expect(system[0]).toContain("(index empty — no memories saved yet)")
  })

  test("skips injection without throwing when the global index read fails", async () => {
    // Given a global store whose index cannot be read
    const globalStore = {
      ...createStore(join(dir, "global")),
      readIndexForInjection: async () => {
        throw new TypeError("global index read failed")
      },
    }
    const system: string[] = ["base prompt"]

    // When memory injection attempts to read both stores
    await injectMemoryForSession(
      {
        globalStore: { kind: "ready", store: globalStore },
        projectStore: { kind: "ready", store: createStore(join(dir, "project")) },
        classifySession: async () => "primary",
      },
      "primary",
      system,
    )

    // Then no memory block is added and the read failure does not escape
    expect(system).toEqual(["base prompt"])
  })

  test("injects memory when session classification is unknown", async () => {
    // Given an unclassifiable session with readable stores
    const system: string[] = []

    // When memory injection runs
    await injectMemoryForSession(
      {
        globalStore: { kind: "ready", store: createStore(join(dir, "global")) },
        projectStore: { kind: "ready", store: createStore(join(dir, "project")) },
        classifySession: async () => "unknown",
      },
      undefined,
      system,
    )

    // Then the optional read path fails open
    expect(system[0]?.split("\n", 1)[0]).toBe(MEMORY_BLOCK_SENTINEL)
  })
})

describe("session suppression", () => {
  test("classifies each session once and caches child status", async () => {
    let lookups = 0
    const classify = createSessionClassifier(async () => {
      lookups += 1
      return { parentID: "parent" }
    })
    expect(await classify("child")).toBe("child")
    expect(await classify("child")).toBe("child")
    expect(lookups).toBe(1)
  })

  test("classifies missing and failed session lookups as unknown", async () => {
    const classify = createSessionClassifier(async () => {
      throw new TypeError("lookup failed")
    })
    expect(await classify(undefined)).toBe("unknown")
    expect(await classify("missing")).toBe("unknown")
  })

  test("a child session receives no injection and cannot save", async () => {
    // Given a runtime that resolves the active session as a child
    const runtime = {
      globalStore: { kind: "ready", store: createStore(join(dir, "global")) } as const,
      projectStore: { kind: "ready", store: createStore(join(dir, "project")) } as const,
      classifySession: async () => "child" as const,
    }
    const system: string[] = []

    // When injection and save are attempted from that session
    await injectMemoryForSession(runtime, "child", system)
    const result = await createMemorySaveTool(runtime).execute(
      { scope: "project", type: "project", slug: "child-fact", description: "child-discovered fact", body: "The child must hand this durable finding to its parent." },
      toolContext("child"),
    )

    // Then neither memory activity is allowed
    expect(system.some((entry) => entry.split("\n", 1)[0] === MEMORY_BLOCK_SENTINEL)).toBe(false)
    expect(result).toHaveProperty("title", "memory_save rejected")
  })

  test("an unknown session cannot save", async () => {
    // Given a runtime that cannot verify the session as primary
    const runtime = {
      globalStore: { kind: "ready", store: createStore(join(dir, "global")) } as const,
      projectStore: { kind: "ready", store: createStore(join(dir, "project")) } as const,
      classifySession: async () => "unknown" as const,
    }

    // When that session attempts to save
    const result = await createMemorySaveTool(runtime).execute(
      { scope: "project", type: "project", slug: "unknown-fact", description: "unclassified finding", body: "This finding must not persist from an unknown session." },
      toolContext("unknown"),
    )

    // Then the existing fail-closed rejection path remains intact
    expect(result).toHaveProperty(
      "output",
      "refused to save because the session could not be verified as primary; only a verified primary session may persist memory",
    )
  })
})
