import { basename, join } from "node:path"
import { createApplyPlan } from "./apply-plan"
import { executeApplyTransaction, recoverApplyTransaction, RecoveryBlockedError, SimulatedCrashError, withStoreLocks, type ApplyCheckpoint } from "./apply-transaction"
import { writeJournal, writeManifest, writeProposal, type RunManifest } from "./artifacts"
import { writeReports } from "./reports"
import type { CurationConfig } from "./curation-config"
import { ensurePrivateDir } from "./private-fs"
import type { ProposalValidation } from "./proposal"
import { RUN_ID_RE } from "./curation-state"
import { captureSnapshot, type CurationStores, type MemorySnapshot } from "./snapshot"

export { recoverApplyTransaction, RecoveryBlockedError, SimulatedCrashError }
export type { ApplyCheckpoint }

export type ApplyInput = {
  readonly runId: string
  readonly runDir: string
  readonly stores: CurationStores
  readonly snapshot: MemorySnapshot
  readonly validation: ProposalValidation
  readonly config: CurationConfig
  readonly clock?: () => number
  readonly fault?: (checkpoint: ApplyCheckpoint) => void | Promise<void>
}

export type ApplyResult =
  | { readonly status: "applied"; readonly postSnapshot: MemorySnapshot; readonly reportPath: string }
  | { readonly status: "report-only" | "stale" | "validation-failed"; readonly reportPath: string }


function manifestFor(input: ApplyInput, status: RunManifest["status"]): RunManifest {
  const plan = createApplyPlan(input.snapshot, input.validation)
  return {
    version: 1,
    runId: input.runId,
    status,
    preSnapshotSha256: input.snapshot.sha256,
    originals: plan.removals.map(({ scope, slug, sha256 }) => ({ scope, slug, sha256 })),
    replacements: [],
    reportPath: join(input.runDir, "report.md"),
  }
}

export async function applyValidatedProposal(input: ApplyInput): Promise<ApplyResult> {
  if (!RUN_ID_RE.test(input.runId) || basename(input.runDir) !== input.runId) throw new TypeError("apply run identity is unsafe")
  const clock = input.clock ?? Date.now
  const plan = createApplyPlan(input.snapshot, input.validation)
  await ensurePrivateDir(input.stores.global, input.runDir)
  await writeProposal(input.stores.global, input.runDir, input.validation)
  if (input.validation.errors.length > 0) {
    const manifest = manifestFor(input, "validation-failed")
    await Promise.all([
      writeManifest(input.stores.global, input.runDir, manifest),
      writeReports(input.stores.global, { dir: input.runDir, id: input.runId, status: "validation-failed" }, { snapshot: input.snapshot, validation: input.validation }),
    ])
    return { status: "validation-failed", reportPath: manifest.reportPath }
  }
  if (input.validation.applicable.length === 0) {
    const manifest = manifestFor(input, "report-only")
    await Promise.all([
      writeManifest(input.stores.global, input.runDir, manifest),
      writeJournal(input.stores.global, input.runDir, [{ phase: "report-only", at: clock() }]),
      writeReports(input.stores.global, { dir: input.runDir, id: input.runId, status: "report-only" }, { snapshot: input.snapshot, validation: input.validation }),
    ])
    return { status: "report-only", reportPath: manifest.reportPath }
  }
  return withStoreLocks(input.stores, async () => {
    const current = await captureSnapshot(input.stores, input.config)
    if (current.sha256 !== input.snapshot.sha256) {
      const manifest = manifestFor(input, "stale")
      await Promise.all([
        writeManifest(input.stores.global, input.runDir, manifest),
        writeJournal(input.stores.global, input.runDir, [{ phase: "stale", at: clock() }]),
        writeReports(input.stores.global, { dir: input.runDir, id: input.runId, status: "stale" }, { snapshot: input.snapshot, validation: input.validation }),
      ])
      return { status: "stale", reportPath: manifest.reportPath }
    }
    await writeReports(input.stores.global, { dir: input.runDir, id: input.runId, status: "applying" }, { snapshot: input.snapshot, validation: input.validation })
    const transaction = {
      runId: input.runId,
      runDir: input.runDir,
      stores: input.stores,
      snapshot: input.snapshot,
      plan,
      config: input.config,
      clock,
      ...(input.fault === undefined ? {} : { fault: input.fault }),
    }
    const postSnapshot = await executeApplyTransaction(transaction)
    try {
      await writeReports(input.stores.global, { dir: input.runDir, id: input.runId, status: "applied" }, { snapshot: input.snapshot, validation: input.validation })
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
    return { status: "applied", postSnapshot, reportPath: join(input.runDir, "report.md") }
  })
}
