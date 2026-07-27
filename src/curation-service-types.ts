import type { Event } from "@opencode-ai/sdk"
import type { CurationConfig } from "./curation-config"
import type { ActiveRun, CurationResult, RecoveryBlock } from "./curation-state"
import type { ApplyCheckpoint } from "./apply"
import type { CurationStores, MemorySnapshot, SnapshotFault } from "./snapshot"
import type { TriggerMetrics } from "./trigger"

export type CurationSession = {
  readonly id: string
  readonly parentID?: string
  readonly title: string
}

export type CurationClient = {
  getSession(sessionID: string): Promise<CurationSession | undefined>
  createSession(parentID: string, title: string): Promise<CurationSession>
  promptAsync(sessionID: string, model: string, tools: Readonly<Record<string, boolean>>, text: string): Promise<void>
  finalAssistant(sessionID: string): Promise<{ readonly text?: string; readonly error?: string }>
  abort(sessionID: string): Promise<void>
  notify(message: string): Promise<void>
}

export type ScheduledTimeout = {
  schedule(callback: () => void, delayMs: number): () => void
}

export type CurationStatus = {
  readonly enabled: boolean
  readonly paused: boolean
  readonly blockedReason: string | null
  readonly active?: ActiveRun
  readonly lastResult?: CurationResult
  readonly nextEligibility: number | null
  readonly metrics: TriggerMetrics
  readonly reportPaths: readonly string[]
  readonly reportExists: boolean
  readonly snapshot?: MemorySnapshot
  readonly snapshotError?: string
  readonly recoveryBlocked?: RecoveryBlock
}

export type CurationService = {
  handleEvent(event: Event): Promise<void>
  run(sessionID: string, dryRun: boolean): Promise<{ readonly accepted: boolean; readonly runId?: string; readonly message: string }>
  status(): Promise<CurationStatus>
  control(sessionID: string, action: "pause" | "resume"): Promise<{ readonly accepted: boolean; readonly message: string }>
  dispose(): Promise<void>
  waitForBackgroundWork(): Promise<void>
}

export type CurationServiceInput = {
  readonly client: CurationClient
  readonly stores: CurationStores
  readonly globalDir: string
  readonly namespace: string
  readonly directory: string
  readonly config: CurationConfig
  readonly clock?: () => number
  readonly scheduler?: ScheduledTimeout
  readonly createRunID?: () => string
  readonly createOwnerToken?: () => string
  readonly applyFault?: (checkpoint: ApplyCheckpoint) => void | Promise<void>
  readonly snapshotFault?: SnapshotFault
}
