import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import { createCurationRuntime } from "../src/curation-runtime"
import type { CurationService } from "../src/curation-service-types"
import { createStore } from "../src/store"

function service(calls: string[]): CurationService {
  return {
    handleEvent: async () => { calls.push("event") },
    run: async () => ({ accepted: true, runId: "run", message: "started" }),
    status: async () => ({
      enabled: true, paused: false, blockedReason: null, nextEligibility: null,
      metrics: { topics: 0, oldestTopicAgeDays: null, lastSuccessAgeDays: null, largestIndexBytes: 0, indexRatio: 0, changedTopics: 0 },
      reportPaths: [], reportExists: false,
    }),
    control: async () => ({ accepted: true, message: "controlled" }),
    dispose: async () => { calls.push("dispose") },
    waitForBackgroundWork: async () => undefined,
  }
}

function context(): ToolContext {
  return {
    sessionID: "primary", messageID: "message", agent: "build", directory: "/workspace", worktree: "/workspace",
    abort: new AbortController().signal, metadata: () => undefined, ask: async () => undefined,
  }
}

describe("curation scope access", () => {
  test.each([
    ["global", { kind: "blocked" }, { kind: "ready", store: createStore("/project") }],
    ["project", { kind: "ready", store: createStore("/global") }, { kind: "blocked" }],
  ] as const)("does not construct curation service when %s recovery is blocked", async (_scope, global, project) => {
    // Given a curation factory with an observable construction and event surface
    const calls: string[] = []
    const runtime = createCurationRuntime({
      global,
      project,
      createService: () => { calls.push("construct"); return service(calls) },
    })

    // When unavailable curation tools are used
    const result = await runtime.tools.memory_curation_run.execute({ dryRun: true }, context())

    // Then no service or event handler exists and the tool is generically unavailable
    expect(runtime.service).toBeUndefined()
    expect(calls).toEqual([])
    expect(result).toHaveProperty("output", expect.stringContaining("memory curation unavailable"))
  })

  test("constructs one service when both scopes are ready", async () => {
    // Given two healthy scope accesses
    const calls: string[] = []
    const runtime = createCurationRuntime({
      global: { kind: "ready", store: createStore("/global") },
      project: { kind: "ready", store: createStore("/project") },
      createService: () => { calls.push("construct"); return service(calls) },
    })

    // When the event surface is used
    await runtime.service?.handleEvent({ type: "server.connected", properties: {} })

    // Then healthy curation remains active
    expect(calls).toEqual(["construct", "event"])
  })
})
