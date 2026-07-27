import { tool } from "@opencode-ai/plugin"
import type { CurationService, CurationStatus } from "./curation-service-types"

function output(title: string, value: unknown) {
  return { title, output: typeof value === "string" ? value : JSON.stringify(value, null, 2) }
}

function publicStatus(status: CurationStatus) {
  return {
    enabled: status.enabled,
    paused: status.paused,
    phase: status.active?.phase ?? "idle",
    ...(status.active === undefined ? {} : { runId: status.active.runId, startedAt: status.active.startedAt, deadlineAt: status.active.deadlineAt }),
    ...(status.lastResult === undefined ? {} : { lastStatus: status.lastResult.status, lastAt: status.lastResult.at }),
    nextEligibility: status.nextEligibility,
    metrics: status.metrics,
    reportExists: status.reportExists,
    blockedReason: status.blockedReason,
    ...(status.snapshotError === undefined ? {} : { error: "memory snapshot unavailable" }),
  }
}

export function createCurationTools(service: CurationService) {
  return {
    memory_curation_status: tool({
      description: "Show redacted automatic memory curation state, last result time, eligibility metrics, and report availability.",
      args: {},
      execute: async () => output("memory curation status", publicStatus(await service.status())),
    }),
    memory_curation_run: tool({
      description: "Force one asynchronous memory curation run. Bypasses thresholds and cooldown, but not pause, active-run, snapshot bounds, or primary-session verification.",
      args: { dryRun: tool.schema.boolean().describe("true writes reports only; false may apply only locally proven exact-duplicate merges") },
      execute: async (args, context) => output("memory curation run", await service.run(context.sessionID, args.dryRun)),
    }),
    memory_curation_control: tool({
      description: "Pause or resume automatic and manual memory curation. Requires a verified primary session.",
      args: { action: tool.schema.enum(["pause", "resume"]) },
      execute: async (args, context) => output("memory curation control", await service.control(context.sessionID, args.action)),
    }),
  }
}

export function createUnavailableCurationTools() {
  const rejected = (title: string) => output(title, { accepted: false, message: "memory curation unavailable in this workspace" })
  return {
    memory_curation_status: tool({ description: "Show why automatic memory curation is unavailable in this workspace.", args: {}, execute: async () => rejected("memory curation status") }),
    memory_curation_run: tool({ description: "Attempt to start memory curation.", args: { dryRun: tool.schema.boolean() }, execute: async () => rejected("memory curation run") }),
    memory_curation_control: tool({ description: "Attempt to pause or resume memory curation.", args: { action: tool.schema.enum(["pause", "resume"]) }, execute: async () => rejected("memory curation control") }),
  }
}
