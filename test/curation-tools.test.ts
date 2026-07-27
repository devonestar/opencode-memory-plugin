import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import { createCurationTools } from "../src/curation-tools"
import type { CurationService } from "../src/curation-service-types"

function context(sessionID = "root"): ToolContext {
  return {
    sessionID,
    messageID: "message",
    agent: "build",
    directory: "/workspace",
    worktree: "/workspace",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  }
}

function fakeService(calls: string[]): CurationService {
  return {
    handleEvent: async () => undefined,
    run: async (_sessionID, dryRun) => {
      calls.push(`run:${dryRun}`)
      return { accepted: true, runId: "run-1", message: "dispatched" }
    },
    status: async () => ({
      enabled: true,
      paused: false,
      blockedReason: null,
      nextEligibility: 123,
      metrics: { topics: 2, oldestTopicAgeDays: 1, lastSuccessAgeDays: null, largestIndexBytes: 50, indexRatio: 0.002, changedTopics: 2 },
      reportPaths: ["/report.md"],
      reportExists: true,
      active: { runId: "run-1", ownerToken: "owner-secret", parentSessionID: "parent-secret", childSessionID: "child-secret", startedAt: 1, deadlineAt: 2, dryRun: false, automatic: true, snapshotSha256: "a".repeat(64), phase: "dispatched" },
      lastResult: { runId: "run-old", status: "failed", at: 99, reportPath: "/private/runs/run-old/report.md", message: "internal-result-message" },
      recoveryBlocked: { runId: "run-blocked", at: 88, message: "internal-recovery-message" },
      snapshot: {
        version: 1,
        sha256: "b".repeat(64),
        totalBytes: 100,
        oldestTopicMtimeMs: 1,
        topics: [{ scope: "global", slug: "private-topic", sha256: "c".repeat(64), bytes: 50, mtimeMs: 1, type: "project", description: "private-description", body: "private-topic-body" }],
        indexes: [{ scope: "global", sha256: "d".repeat(64), bytes: 10, raw: "private-index-raw" }, { scope: "project", sha256: "e".repeat(64), bytes: 0, raw: "" }],
      },
      snapshotError: "/private/store/MEMORY.md included private-topic-body",
    }),
    control: async (_sessionID, action) => {
      calls.push(`control:${action}`)
      return { accepted: true, message: action }
    },
    dispose: async () => undefined,
    waitForBackgroundWork: async () => undefined,
  }
}

describe("memory curation tools", () => {
  test("exposes strict status, run, and control schemas", () => {
    // Given curation tools backed by a service
    const tools = createCurationTools(fakeService([]))

    // When argument schemas are inspected
    const runDry = tools.memory_curation_run.args.dryRun.safeParse(true)
    const runMissing = tools.memory_curation_run.args.dryRun.safeParse(undefined)
    const pause = tools.memory_curation_control.args.action.safeParse("pause")
    const invalidControl = tools.memory_curation_control.args.action.safeParse("stop")

    // Then only the closed command values are accepted
    expect(Object.keys(tools).sort()).toEqual(["memory_curation_control", "memory_curation_run", "memory_curation_status"])
    expect(runDry.success).toBe(true)
    expect(runMissing.success).toBe(false)
    expect(pause.success).toBe(true)
    expect(invalidControl.success).toBe(false)
  })

  test("each mutation tool invokes exactly one matching service operation", async () => {
    // Given a call-recording curation service
    const calls: string[] = []
    const tools = createCurationTools(fakeService(calls))

    // When each mutation tool executes once
    await tools.memory_curation_run.execute({ dryRun: true }, context())
    await tools.memory_curation_control.execute({ action: "pause" }, context())

    // Then no wrapper performs a second service action
    expect(calls).toEqual(["run:true", "control:pause"])
  })

  test("status recursively exposes only the redacted public DTO without mutation authorization", async () => {
    // Given a service status containing operator-facing metrics
    const tools = createCurationTools(fakeService([]))

    // When status is requested
    const result = await tools.memory_curation_status.execute({}, context("unverified-child"))

    // Then the output carries eligibility and reports but no raw snapshot
    expect(result).toHaveProperty("title", "memory curation status")
    expect(result).toHaveProperty("output")
    const output = typeof result === "string" ? result : result.output
    const parsed: unknown = JSON.parse(output)
    if (typeof parsed !== "object" || parsed === null) throw new TypeError("status output is not an object")
    expect(Object.keys(parsed).sort()).toEqual(["blockedReason", "deadlineAt", "enabled", "error", "lastAt", "lastStatus", "metrics", "nextEligibility", "paused", "phase", "reportExists", "runId", "startedAt"].sort())
    const serialized = JSON.stringify(parsed)
    for (const privateValue of ["owner-secret", "parent-secret", "child-secret", "/private/", "private-topic-body", "private-index-raw", "private-description", "internal-result-message", "internal-recovery-message", "b".repeat(64)]) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(parsed).toHaveProperty("nextEligibility", 123)
    expect(parsed).toHaveProperty("reportExists", true)
    expect(parsed).toHaveProperty("error", "memory snapshot unavailable")
  })
})
