import { join } from "node:path"
import { recoverApplyTransaction, RecoveryBlockedError } from "./apply"
import { readManifest, writeFailureArtifacts, writeOrphanFailureArtifacts } from "./artifacts"
import type { ActiveRun, CurationRepository } from "./curation-state"
import type { CurationClient, ScheduledTimeout } from "./curation-service-types"
import { readRunSnapshot } from "./run-snapshot"
import { captureSnapshot, type CurationStores, type MemorySnapshot } from "./snapshot"
import { snapshotInventory } from "./trigger"
import type { CurationConfig } from "./curation-config"
import { writePrivate } from "./private-fs"
import { INTEGRITY_BOUNDARY } from "./reports"

export type RecoveredRuntime = {
  readonly runId: string
  readonly ownerToken: string
  readonly snapshot: MemorySnapshot
  readonly cancelTimeout: () => void
  readonly localOwner: false
}

type RecoveryInput = {
  readonly repository: CurationRepository
  readonly client: CurationClient
  readonly stores: CurationStores
  readonly globalDir: string
  readonly config: CurationConfig
  readonly clock: () => number
  readonly scheduler: ScheduledTimeout
  readonly abortOnce: (childSessionID: string) => Promise<void>
  readonly timeout: (runId: string, ownerToken: string, snapshot: MemorySnapshot) => Promise<void>
}

async function persistedSnapshot(input: RecoveryInput, active: ActiveRun): Promise<MemorySnapshot> {
  return readRunSnapshot(input.globalDir, join(input.repository.paths.runs, active.runId), active.snapshotSha256)
}

async function completeFailure(input: RecoveryInput, active: ActiveRun, status: "failed" | "timeout", message: string, snapshot?: MemorySnapshot): Promise<void> {
  const runDir = join(input.repository.paths.runs, active.runId)
  const manifest = snapshot === undefined
    ? await writeOrphanFailureArtifacts(input.globalDir, runDir, active.runId, active.snapshotSha256, status, message, input.clock())
    : await writeFailureArtifacts(input.globalDir, runDir, active.runId, snapshot, status, message, input.clock())
  await input.repository.complete(active.runId, active.ownerToken, { runId: active.runId, status, at: input.clock(), reportPath: manifest.reportPath, message })
}

async function recoverApplied(input: RecoveryInput, active: ActiveRun, manifest: Awaited<ReturnType<typeof readManifest>>): Promise<void> {
  let current: MemorySnapshot | undefined
  let snapshotError: string | undefined
  try {
    current = await captureSnapshot(input.stores, input.config)
  } catch (error) {
    snapshotError = error instanceof Error ? error.message : "current memory snapshot is unavailable"
  }
  await input.repository.complete(
    active.runId,
    active.ownerToken,
    { runId: active.runId, status: "applied", at: input.clock(), reportPath: manifest.reportPath },
    current === undefined ? undefined : { at: input.clock(), inventory: snapshotInventory(current) },
  )
  const drift = current === undefined || manifest.postSnapshotSha256 === undefined
    ? "unknown"
    : current.sha256 === manifest.postSnapshotSha256 ? "none" : "later memory changes preserved"
  const report = [
    `# Memory curation ${active.runId}`,
    "",
    "Status: applied",
    `Committed snapshot: ${manifest.postSnapshotSha256 ?? "recorded by applied manifest"}`,
    `Current snapshot drift: ${drift}`,
    "",
    `Threat model: ${INTEGRITY_BOUNDARY}`,
    "",
  ].join("\n")
  try {
    await writePrivate(input.globalDir, manifest.reportPath, report)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    await input.repository.recordError(`post-commit report recovery failed: ${error.message}`, input.clock()).catch(() => undefined)
  }
  if (snapshotError !== undefined) await input.repository.recordError(`applied recovery snapshot unavailable: ${snapshotError}`, input.clock()).catch(() => undefined)
}

async function recoverFinalizing(input: RecoveryInput, active: ActiveRun, snapshot: MemorySnapshot, manifest: Awaited<ReturnType<typeof readManifest>>): Promise<void> {
  const runDir = join(input.repository.paths.runs, active.runId)
  if (manifest.status === "applying") {
    try {
      const recovered = await recoverApplyTransaction({ runId: active.runId, runDir, stores: input.stores, config: input.config })
      if (recovered.status === "committed") {
        await input.repository.complete(active.runId, active.ownerToken, { runId: active.runId, status: "applied", at: input.clock(), reportPath: manifest.reportPath }, { at: input.clock(), inventory: snapshotInventory(recovered.snapshot) })
      } else {
        await completeFailure(input, active, "failed", "interrupted apply rolled back during startup recovery", recovered.snapshot)
      }
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown apply recovery failure"
      if (error instanceof RecoveryBlockedError) {
        await input.repository.blockRecovery(active.runId, message, input.clock())
        return
      }
      throw error
    }
  }
  switch (manifest.status) {
    case "report-only":
      await input.repository.complete(active.runId, active.ownerToken, { runId: active.runId, status: "no-op", at: input.clock(), reportPath: manifest.reportPath }, { at: input.clock(), inventory: snapshotInventory(snapshot) })
      return
    case "dry-run":
      await input.repository.complete(active.runId, active.ownerToken, { runId: active.runId, status: "dry-run", at: input.clock(), reportPath: manifest.reportPath }, { at: input.clock(), inventory: snapshotInventory(snapshot) })
      return
    case "stale":
    case "validation-failed":
    case "failed":
    case "timeout":
      await input.repository.complete(active.runId, active.ownerToken, { runId: active.runId, status: manifest.status, at: input.clock(), reportPath: manifest.reportPath })
      return
    case "running":
      break
  }
  await completeFailure(input, active, "failed", "curator finalization was interrupted before an apply plan was prepared", snapshot)
}

export async function recoverStartup(input: RecoveryInput): Promise<RecoveredRuntime | undefined> {
  const state = await input.repository.readState()
  const active = state.active
  if (active === undefined) return undefined
  let finalizingManifest: Awaited<ReturnType<typeof readManifest>> | undefined
  if (active.phase === "finalizing") {
    try {
      finalizingManifest = await readManifest(input.globalDir, join(input.repository.paths.runs, active.runId))
      if (finalizingManifest.status === "applied") {
        await recoverApplied(input, active, finalizingManifest)
        return undefined
      }
    } catch (error) {
      await input.repository.blockRecovery(active.runId, error instanceof Error ? error.message : "curation manifest is unreadable", input.clock())
      return undefined
    }
  }
  let snapshot: MemorySnapshot | undefined
  try {
    snapshot = await persistedSnapshot(input, active)
  } catch (error) {
    const message = error instanceof Error ? error.message : "persisted curation snapshot is unavailable"
    await completeFailure(input, active, "failed", message)
    return undefined
  }
  switch (active.phase) {
    case "reserved":
      await completeFailure(input, active, "failed", "curation startup was interrupted before child dispatch", snapshot)
      return undefined
    case "finalizing":
      try {
        if (finalizingManifest === undefined) throw new TypeError("curation manifest is unavailable during finalizing recovery")
        await recoverFinalizing(input, active, snapshot, finalizingManifest)
      } catch (error) {
        await input.repository.blockRecovery(active.runId, error instanceof Error ? error.message : "curation recovery artifacts are unreadable", input.clock())
      }
      return undefined
    case "timed-out":
      if (active.childSessionID !== undefined) await input.abortOnce(active.childSessionID)
      await completeFailure(input, active, "timeout", "curator timed out before service restart completed", snapshot)
      return undefined
    case "dispatched": {
      if (active.deadlineAt <= input.clock()) {
        await input.timeout(active.runId, active.ownerToken, snapshot)
        return undefined
      }
      const child = active.childSessionID === undefined ? undefined : await input.client.getSession(active.childSessionID)
      if (child === undefined || child.parentID !== active.parentSessionID) {
        await completeFailure(input, active, "failed", "persisted curator child is missing or invalid", snapshot)
        return undefined
      }
      const cancelTimeout = input.scheduler.schedule(() => { void input.timeout(active.runId, active.ownerToken, snapshot) }, active.deadlineAt - input.clock())
      return { runId: active.runId, ownerToken: active.ownerToken, snapshot, cancelTimeout, localOwner: false }
    }
    default:
      return active.phase
  }
}
