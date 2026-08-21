import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { injectMemoryForSession } from "../src/runtime"
import { createCurationSuggestionRepository } from "../src/curation-suggestions"
import { createStore } from "../src/store"
import type { ProposalOperation } from "../src/proposal"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-suggestion-delivery-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("suggestion delivery", () => {
  test("reserves the ordinary block before awaiting a claim so concurrent injection consumes one batch", async () => {
    // Given a claim held open after the first injection reaches the suggestion inbox
    const claimEntered = Promise.withResolvers<void>()
    const releaseClaim = Promise.withResolvers<void>()
    let claims = 0
    const entry = {
      key: "a".repeat(64), runId: "run", operationId: "operation",
      kind: "REWRITE" as const,
      reasonCode: "stale-detail",
      sources: [{ scope: "project" as const, slug: "source", sha256: "b".repeat(64) }],
      destination: { scope: "project" as const, slug: "destination" },
      createdAt: 1, updatedAt: 1,
    }
    const runtime = {
      globalStore: { kind: "ready", store: createStore(join(dir, "global")) } as const,
      projectStore: { kind: "ready", store: createStore(join(dir, "project")) } as const,
      classifySession: async () => "primary" as const,
      suggestionRepository: {
        claim: async (_limit: number, fits: (candidate: readonly typeof entry[]) => boolean) => {
          claims += 1
          claimEntered.resolve()
          await releaseClaim.promise
          return fits([entry]) ? [entry] : []
        },
      },
    }
    const system: string[] = []

    // When a second injection starts against the same prompt while the first claim is pending
    const first = injectMemoryForSession(runtime, "primary", system)
    await claimEntered.promise
    const second = injectMemoryForSession(runtime, "primary", system)
    releaseClaim.resolve()
    await Promise.all([first, second])

    // Then the reservation prevents another claim and renders a bounded scoped source
    expect(claims).toBe(1)
    expect(system).toHaveLength(1)
    expect(system[0]).toContain("sources=project:source")
  })

  test("consumes only suggestions whose exact report locators fit the rendered block", async () => {
    // Given three oldest-first suggestions with worst-case locator IDs and a minimum-size prompt budget
    const globalDir = join(dir, "global")
    const projectDir = join(dir, "project")
    await Promise.all([mkdir(globalDir, { recursive: true }), mkdir(projectDir, { recursive: true })])
    const repository = createCurationSuggestionRepository(globalDir, "namespace")
    for (let index = 0; index < 3; index += 1) {
      const operation: ProposalOperation = {
        id: `${String(index)}-${"o".repeat(97)}`,
        kind: "REWRITE",
        confidence: "high",
        reasonCode: `reason-${"r".repeat(140)}`,
        sources: [{ scope: "project", slug: `source-${String(index)}-${"s".repeat(140)}`, sha256: String(index).repeat(64) }],
        replacement: { scope: "project", slug: `destination-${"d".repeat(140)}`, type: "project", description: "description", body: "body" },
      }
      await repository.add({ runId: `${String(index)}-${"r".repeat(125)}`, operation, at: index })
    }
    const runtime = {
      globalStore: { kind: "ready", store: createStore(globalDir) } as const,
      projectStore: { kind: "ready", store: createStore(projectDir) } as const,
      classifySession: async () => "primary" as const,
      suggestionRepository: repository,
    }
    const system: string[] = []
    const config = { maxBlockBytes: 2_048, pointerBudgetBytes: 512, pointerMaxLines: 1, projectShare: 0.6 }

    // When primary-session injection claims against the renderer's actual capacity
    await injectMemoryForSession(runtime, "primary", system, config)

    // Then every consumed entry has an exact self-resolving pair and every unrendered entry remains queued
    const rendered = system[0]?.split("\n").filter((line) => line.startsWith("- kind=")) ?? []
    const remaining = await repository.list()
    expect(rendered.length).toBeGreaterThanOrEqual(1)
    expect(rendered.length + remaining.length).toBe(3)
    for (let index = 0; index < rendered.length; index += 1) {
      expect(rendered[index]).toContain(`run_id=${String(index)}-${"r".repeat(125)}`)
      expect(rendered[index]).toContain(`operation_id=${String(index)}-${"o".repeat(97)}`)
    }
    expect(system[0]).toContain("runs/<run_id>/report.md")
  })
})
