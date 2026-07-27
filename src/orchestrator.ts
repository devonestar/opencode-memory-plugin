import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { access } from "node:fs/promises"
import { applyValidatedProposal } from "./apply"
import { initializeRunArtifacts, writeFailureArtifacts, writeReviewArtifacts } from "./artifacts"
import { createCurationRepository, RUN_ID_RE, type ActiveRun, type CurationRepository } from "./curation-state"
import type { CurationClient, CurationService, CurationServiceInput, CurationSession, CurationStatus, ScheduledTimeout } from "./curation-service-types"
import { buildCuratorPrompt } from "./curator-prompt"
import { parseProposal, validateProposal } from "./proposal"
import { recoverStartup, type RecoveredRuntime } from "./startup-recovery"
import { captureSnapshot, type CurationStores, type MemorySnapshot } from "./snapshot"
import type { CurationConfig } from "./curation-config"
import { evaluateEligibility, snapshotInventory, type Eligibility } from "./trigger"

export type { CurationClient, CurationService, CurationServiceInput, CurationSession, CurationStatus, ScheduledTimeout } from "./curation-service-types"

const TITLE_PREFIX = "[memory-curation:"
const DEFAULT_SCHEDULER: ScheduledTimeout = { schedule: (callback, delayMs) => { const handle = setTimeout(callback, delayMs); return () => clearTimeout(handle) } }

type ActiveRuntime = RecoveredRuntime | {
  readonly runId: string
  readonly ownerToken: string
  readonly snapshot: MemorySnapshot
  readonly cancelTimeout: () => void
  readonly localOwner: true
}

function history(state: Awaited<ReturnType<CurationRepository["readState"]>>) {
  return {
    ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
    ...(state.lastAutomaticAttemptAt === undefined ? {} : { lastAutomaticAttemptAt: state.lastAutomaticAttemptAt }),
    ...(state.inventory === undefined ? {} : { inventory: state.inventory }),
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown curation failure"
}

export function createCurationService(input: CurationServiceInput): CurationService {
  const clock = input.clock ?? Date.now
  const scheduler = input.scheduler ?? DEFAULT_SCHEDULER
  const createRunID = input.createRunID ?? (() => `run-${clock()}-${randomUUID().toLowerCase()}`)
  const createOwnerToken = input.createOwnerToken ?? randomUUID
  const capture = (stores: CurationStores, config: CurationConfig): Promise<MemorySnapshot> => captureSnapshot(stores, config, input.snapshotFault)
  const repository = createCurationRepository(input.globalDir, input.namespace)
  const pending = new Set<Promise<void>>()
  const aborted = new Set<string>()
  let runtime: ActiveRuntime | undefined

  const track = (work: Promise<void>): void => {
    const handled = work.catch(async (error: unknown) => repository.recordError(message(error), clock())).catch(() => undefined)
    pending.add(handled)
    void handled.then(() => pending.delete(handled))
  }
  const abortOnce = async (childSessionID: string): Promise<void> => {
    if (aborted.has(childSessionID)) return
    aborted.add(childSessionID)
    await input.client.abort(childSessionID)
  }
  const clearRuntime = (runId: string): void => {
    if (runtime?.runId !== runId) return
    runtime.cancelTimeout()
    runtime = undefined
  }
  const completeFailure = async (active: ActiveRun, snapshot: MemorySnapshot, status: "failed" | "timeout", detail: string): Promise<void> => {
    clearRuntime(active.runId)
    const runDir = join(repository.paths.runs, active.runId)
    const manifest = await writeFailureArtifacts(input.globalDir, runDir, active.runId, snapshot, status, detail, clock())
    await repository.complete(active.runId, active.ownerToken, { runId: active.runId, status, at: clock(), reportPath: manifest.reportPath, message: detail })
  }
  const notify = async (detail: string): Promise<void> => {
    if (!input.config.notify) return
    try {
      await input.client.notify(detail)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      await repository.recordError(`curation notification failed: ${error.message}`, clock()).catch(() => undefined)
    }
  }
  const timeout = async (runId: string, ownerToken: string, snapshot: MemorySnapshot): Promise<void> => {
    const active = await repository.claim(runId, ownerToken, "dispatched", "timed-out")
    if (active === undefined) return
    if (active.childSessionID !== undefined) await abortOnce(active.childSessionID)
    await completeFailure(active, snapshot, "timeout", `curator exceeded ${input.config.timeoutSeconds} seconds`)
    await notify(`Memory curation ${runId} timed out; see its report.`)
  }

  const ready = recoverStartup({ repository, client: input.client, stores: input.stores, globalDir: input.globalDir, config: input.config, clock, scheduler, abortOnce, timeout })
    .then((recovered) => { runtime = recovered })

  const verifyRoot = async (sessionID: string): Promise<CurationSession | undefined> => {
    const session = await input.client.getSession(sessionID)
    return session === undefined || session.parentID !== undefined || session.title.startsWith(TITLE_PREFIX) ? undefined : session
  }
  const start = async (parent: CurationSession, dryRun: boolean, automatic: boolean, snapshot: MemorySnapshot, eligibility: Eligibility) => {
    const now = clock()
    const runId = createRunID()
    if (!RUN_ID_RE.test(runId)) throw new TypeError("generated curation run ID is unsafe")
    const ownerToken = createOwnerToken()
    const lease: ActiveRun = { runId, ownerToken, parentSessionID: parent.id, startedAt: now, deadlineAt: now + input.config.timeoutSeconds * 1000, dryRun, automatic, snapshotSha256: snapshot.sha256, phase: "reserved" }
    if (!(await repository.reserve(lease, eligibility.metrics))) return { accepted: false, message: "another curation run is active, blocked, or reused its run ID" }
    const runDir = join(repository.paths.runs, runId)
    try {
      await initializeRunArtifacts(input.globalDir, runDir, runId, snapshot, now)
      const child = await input.client.createSession(parent.id, `${TITLE_PREFIX}${runId}] automatic memory audit`)
      await repository.attachChild(runId, ownerToken, child.id)
      const verified = await input.client.getSession(child.id)
      if (verified?.parentID !== parent.id || !verified.title.startsWith(TITLE_PREFIX)) throw new TypeError("curator child session verification failed")
      const cancelTimeout = scheduler.schedule(() => track(timeout(runId, ownerToken, snapshot)), input.config.timeoutSeconds * 1000)
      runtime = { runId, ownerToken, snapshot, cancelTimeout, localOwner: true }
      await input.client.promptAsync(child.id, input.config.model, { "*": false }, buildCuratorPrompt(snapshot))
      return { accepted: true, runId, message: `memory curation ${runId} dispatched` }
    } catch (error) {
      if (!(error instanceof Error)) throw error
      const state = await repository.readState()
      if (state.active?.runId === runId && state.active.ownerToken === ownerToken) await completeFailure(state.active, snapshot, "failed", error.message)
      return { accepted: false, runId, message: error.message }
    }
  }

  const finalize = async (candidate: ActiveRun): Promise<void> => {
    const active = await repository.claim(candidate.runId, candidate.ownerToken, "dispatched", "finalizing")
    if (active === undefined) return
    const activeRuntime = runtime
    if (activeRuntime === undefined || activeRuntime.runId !== active.runId) return completeFailure(active, await capture(input.stores, input.config), "failed", "active curator snapshot is unavailable")
    const bounded = Promise.withResolvers<{ readonly kind: "timeout" }>()
    const cancelBound = scheduler.schedule(() => bounded.resolve({ kind: "timeout" }), Math.max(0, active.deadlineAt - clock()))
    activeRuntime.cancelTimeout()
    const final = await Promise.race([input.client.finalAssistant(active.childSessionID ?? "").then((value) => ({ kind: "result" as const, value })), bounded.promise])
    cancelBound()
    if (final.kind === "timeout") {
      if (active.childSessionID !== undefined) await abortOnce(active.childSessionID)
      return completeFailure(active, activeRuntime.snapshot, "timeout", "curator result retrieval exceeded its deadline")
    }
    if (final.value.error !== undefined) return completeFailure(active, activeRuntime.snapshot, "failed", final.value.error)
    if (final.value.text === undefined) return completeFailure(active, activeRuntime.snapshot, "failed", "curator returned no assistant text")
    if (Buffer.byteLength(final.value.text, "utf8") > input.config.maxOutputBytes) return completeFailure(active, activeRuntime.snapshot, "failed", "curator output exceeds maxOutputBytes")
    let committed = false
    try {
      const validation = validateProposal(parseProposal(final.value.text), activeRuntime.snapshot, input.config)
      const runDir = join(repository.paths.runs, active.runId)
      if (active.dryRun || validation.errors.length > 0) {
        const status = validation.errors.length > 0 ? "validation-failed" : "dry-run"
        const manifest = await writeReviewArtifacts(input.globalDir, runDir, active.runId, activeRuntime.snapshot, validation, status, clock())
        clearRuntime(active.runId)
        await repository.complete(active.runId, active.ownerToken, { runId: active.runId, status, at: clock(), reportPath: manifest.reportPath }, status === "dry-run" ? { at: clock(), inventory: snapshotInventory(activeRuntime.snapshot) } : undefined)
        await notify(`Memory curation ${active.runId} completed as ${status}; see ${manifest.reportPath}.`)
        return
      }
      const applied = await applyValidatedProposal({ runId: active.runId, runDir, stores: input.stores, snapshot: activeRuntime.snapshot, validation, config: input.config, clock, ...(input.applyFault === undefined ? {} : { fault: input.applyFault }) })
      committed = applied.status === "applied"
      clearRuntime(active.runId)
      const successSnapshot = applied.status === "applied" ? applied.postSnapshot : applied.status === "no-op" ? activeRuntime.snapshot : undefined
      await repository.complete(active.runId, active.ownerToken, { runId: active.runId, status: applied.status, at: clock(), reportPath: applied.reportPath }, successSnapshot === undefined ? undefined : { at: clock(), inventory: snapshotInventory(successSnapshot) })
      await notify(`Memory curation ${active.runId} completed as ${applied.status}; see ${applied.reportPath}.`)
    } catch (error) {
      if (input.applyFault !== undefined) throw error
      if (!(error instanceof Error)) throw error
      if (committed) {
        await repository.recordError(`post-commit finalization failed: ${error.message}`, clock())
        return
      }
      await completeFailure(active, activeRuntime.snapshot, "failed", error.message)
    }
  }

  const candidate = async (sessionID: string): Promise<void> => {
    await ready
    const state = await repository.readState()
    if (state.active !== undefined || state.recoveryBlocked !== undefined || !input.config.allowProviderEgress) return
    const parent = await verifyRoot(sessionID)
    if (parent === undefined) return
      const snapshot = await capture(input.stores, input.config)
    const paused = await repository.paused()
    const eligibility = evaluateEligibility({ snapshot, history: history(state), config: input.config, now: clock(), paused })
    if (eligibility.eligible) await start(parent, false, true, snapshot, eligibility)
  }

  const status = async (): Promise<CurationStatus> => {
    await ready
    const [state, paused] = await Promise.all([repository.readState(), repository.paused()])
    const reportPaths = [state.active === undefined ? undefined : join(repository.paths.runs, state.active.runId, "report.md"), state.lastResult?.reportPath].filter((path): path is string => path !== undefined)
    const reportExists = (await Promise.all(reportPaths.map(async (path) => {
      try { await access(path); return true } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error }
    }))).some(Boolean)
    const blocks = [state.recoveryBlocked === undefined ? undefined : "recovery blocked", input.config.enabled ? undefined : "curation disabled", input.config.allowProviderEgress ? undefined : "provider egress disabled"].filter((value): value is string => value !== undefined)
    const blockedReason = blocks.length === 0 ? null : blocks.join("; ")
    try {
      const snapshot = await capture(input.stores, input.config)
      const eligibility = evaluateEligibility({ snapshot, history: history(state), config: input.config, now: clock(), paused })
      return { enabled: input.config.enabled && input.config.allowProviderEgress && state.recoveryBlocked === undefined, paused, blockedReason, ...(state.active === undefined ? {} : { active: state.active }), ...(state.lastResult === undefined ? {} : { lastResult: state.lastResult }), ...(state.recoveryBlocked === undefined ? {} : { recoveryBlocked: state.recoveryBlocked }), nextEligibility: blockedReason === null ? eligibility.nextEligibleAt : null, metrics: eligibility.metrics, reportPaths, reportExists, snapshot }
    } catch (error) {
      if (!(error instanceof Error)) throw error
      return { enabled: input.config.enabled && input.config.allowProviderEgress && state.recoveryBlocked === undefined, paused, blockedReason, ...(state.active === undefined ? {} : { active: state.active }), ...(state.lastResult === undefined ? {} : { lastResult: state.lastResult }), ...(state.recoveryBlocked === undefined ? {} : { recoveryBlocked: state.recoveryBlocked }), nextEligibility: null, metrics: state.lastMetrics ?? { topics: 0, oldestTopicAgeDays: null, lastSuccessAgeDays: null, largestIndexBytes: 0, indexRatio: 0, changedTopics: 0 }, reportPaths, reportExists, snapshotError: error.message }
    }
  }

  return {
    handleEvent: async (event) => {
      if (event.type !== "session.status" || event.properties.status.type !== "idle") return
      track(ready.then(async () => {
        const active = (await repository.readState()).active
        if (active?.childSessionID === event.properties.sessionID) await finalize(active)
        else await candidate(event.properties.sessionID)
      }))
    },
    run: async (sessionID, dryRun) => {
      await ready
      const parent = await verifyRoot(sessionID)
      if (parent === undefined) return { accepted: false, message: "curation mutations require a verified primary session" }
      if (!input.config.allowProviderEgress) return { accepted: false, message: "memory curation is blocked because provider egress is disabled" }
      const [state, paused] = await Promise.all([repository.readState(), repository.paused()])
      let snapshot: MemorySnapshot
      try { snapshot = await capture(input.stores, input.config) } catch (error) { if (!(error instanceof Error)) throw error; await repository.recordError(error.message, clock()); return { accepted: false, message: error.message } }
      const eligibility = evaluateEligibility({ snapshot, history: history(state), config: input.config, now: clock(), paused, force: true })
      return eligibility.eligible ? start(parent, dryRun, false, snapshot, eligibility) : { accepted: false, message: `memory curation is blocked by ${eligibility.blockedBy ?? "policy"}` }
    },
    status,
    control: async (sessionID, action) => { await ready; if ((await verifyRoot(sessionID)) === undefined) return { accepted: false, message: "curation control requires a verified primary session" }; await repository.setPaused(action === "pause"); return { accepted: true, message: `memory curation ${action === "pause" ? "paused" : "resumed"}` } },
    dispose: async () => {
      await ready
      const owned = runtime
      if (owned === undefined) return
      owned.cancelTimeout()
      if (!owned.localOwner) {
        runtime = undefined
        return
      }
      const active = (await repository.readState()).active
      if (active?.runId !== owned.runId || active.ownerToken !== owned.ownerToken) {
        runtime = undefined
        return
      }
      switch (active.phase) {
        case "reserved":
        case "dispatched":
          runtime = undefined
          if (active.childSessionID !== undefined) await abortOnce(active.childSessionID)
          await completeFailure(active, owned.snapshot, "failed", "curator aborted during plugin disposal")
          return
        case "finalizing":
          return
        case "timed-out":
          runtime = undefined
          return
        default:
          return active.phase
      }
    },
    waitForBackgroundWork: async () => { while (pending.size > 0) await Promise.all([...pending]) },
  }
}
