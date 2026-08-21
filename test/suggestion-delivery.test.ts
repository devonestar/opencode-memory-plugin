import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { injectMemoryForSession } from "../src/runtime"
import { createStore } from "../src/store"

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
        claim: async () => {
          claims += 1
          claimEntered.resolve()
          await releaseClaim.promise
          return [entry]
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
})
