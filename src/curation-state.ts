import { join } from "node:path"
import { tool } from "@opencode-ai/plugin"
import { withLock } from "./fsutil"
import { createPrivateDirExclusive, ensurePrivateDir, readPrivate, writePrivate } from "./private-fs"
import type { TriggerMetrics } from "./trigger"

export const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/
export const RUN_PHASES = ["reserved", "dispatched", "finalizing", "timed-out"] as const
export type RunPhase = (typeof RUN_PHASES)[number]

export type ActiveRun = {
  readonly runId: string
  readonly ownerToken: string
  readonly parentSessionID: string
  readonly childSessionID?: string
  readonly startedAt: number
  readonly deadlineAt: number
  readonly dryRun: boolean
  readonly automatic: boolean
  readonly snapshotSha256: string
  readonly phase: RunPhase
}

export type CurationResultStatus = "applied" | "no-op" | "dry-run" | "stale" | "validation-failed" | "failed" | "timeout"
export type CurationResult = { readonly runId: string; readonly status: CurationResultStatus; readonly at: number; readonly reportPath?: string; readonly message?: string }
export type RecoveryBlock = { readonly runId: string; readonly at: number; readonly message: string }

export type CurationState = {
  readonly version: 1
  readonly active?: ActiveRun
  readonly recoveryBlocked?: RecoveryBlock
  readonly lastAutomaticAttemptAt?: number
  readonly lastSuccessAt?: number
  readonly inventory?: Readonly<Record<string, string>>
  readonly lastResult?: CurationResult
  readonly history?: readonly CurationResult[]
  readonly lastMetrics?: TriggerMetrics
  readonly lastError?: { readonly at: number; readonly message: string }
}

export type CurationPaths = { readonly root: string; readonly runs: string; readonly state: string; readonly settings: string }

export type CurationRepository = {
  readonly paths: CurationPaths
  readState(): Promise<CurationState>
  paused(): Promise<boolean>
  setPaused(paused: boolean): Promise<void>
  reserve(lease: ActiveRun, metrics: TriggerMetrics): Promise<boolean>
  attachChild(runId: string, ownerToken: string, childSessionID: string): Promise<void>
  claim(runId: string, ownerToken: string, from: RunPhase, to: RunPhase): Promise<ActiveRun | undefined>
  complete(runId: string, ownerToken: string, result: CurationResult, success?: { readonly at: number; readonly inventory: Readonly<Record<string, string>> }): Promise<void>
  blockRecovery(runId: string, message: string, at: number): Promise<void>
  recordError(message: string, at: number): Promise<void>
}

const z = tool.schema
const resultSchema = z.object({ runId: z.string(), status: z.enum(["applied", "no-op", "dry-run", "stale", "validation-failed", "failed", "timeout"]), at: z.number(), reportPath: z.string().optional(), message: z.string().optional() }).strict()
const activeSchema = z.object({ runId: z.string().regex(RUN_ID_RE), ownerToken: z.string().min(1), parentSessionID: z.string().min(1), childSessionID: z.string().min(1).optional(), startedAt: z.number(), deadlineAt: z.number(), dryRun: z.boolean(), automatic: z.boolean(), snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(RUN_PHASES).optional() }).strict()
const metricsSchema = z.object({ topics: z.number(), oldestTopicAgeDays: z.number().nullable(), lastSuccessAgeDays: z.number().nullable(), largestIndexBytes: z.number(), indexRatio: z.number(), changedTopics: z.number() }).strict()
const stateSchema = z.object({
  version: z.literal(1),
  active: activeSchema.optional(),
  recoveryBlocked: z.object({ runId: z.string(), at: z.number(), message: z.string() }).strict().optional(),
  lastAutomaticAttemptAt: z.number().optional(),
  lastSuccessAt: z.number().optional(),
  inventory: z.record(z.string(), z.string()).optional(),
  lastResult: resultSchema.optional(),
  history: z.array(resultSchema).max(50).optional(),
  lastMetrics: metricsSchema.optional(),
  lastError: z.object({ at: z.number(), message: z.string() }).strict().optional(),
}).strict()

function exactResult(result: ReturnType<typeof resultSchema.parse>): CurationResult {
  return { runId: result.runId, status: result.status, at: result.at, ...(result.reportPath === undefined ? {} : { reportPath: result.reportPath }), ...(result.message === undefined ? {} : { message: result.message }) }
}

async function readJson(root: string, path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readPrivate(root, path))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    if (error instanceof SyntaxError) throw new TypeError(`curation state is malformed: ${path}`)
    throw error
  }
}

async function loadState(root: string, path: string): Promise<CurationState> {
  const decoded = await readJson(root, path)
  if (decoded === undefined) return { version: 1 }
  const parsed = stateSchema.safeParse(decoded)
  if (!parsed.success) throw new TypeError(`curation state is malformed: ${parsed.error.message}`)
  const data = parsed.data
  const active = data.active === undefined
    ? undefined
    : data.active.childSessionID === undefined
      ? {
          runId: data.active.runId,
          ownerToken: data.active.ownerToken,
          parentSessionID: data.active.parentSessionID,
          startedAt: data.active.startedAt,
          deadlineAt: data.active.deadlineAt,
          dryRun: data.active.dryRun,
          automatic: data.active.automatic,
          snapshotSha256: data.active.snapshotSha256,
          phase: data.active.phase ?? "reserved",
        }
      : { ...data.active, childSessionID: data.active.childSessionID, phase: data.active.phase ?? "dispatched" }
  return {
    version: 1,
    ...(active === undefined ? {} : { active }),
    ...(data.recoveryBlocked === undefined ? {} : { recoveryBlocked: data.recoveryBlocked }),
    ...(data.lastAutomaticAttemptAt === undefined ? {} : { lastAutomaticAttemptAt: data.lastAutomaticAttemptAt }),
    ...(data.lastSuccessAt === undefined ? {} : { lastSuccessAt: data.lastSuccessAt }),
    ...(data.inventory === undefined ? {} : { inventory: data.inventory }),
    ...(data.lastResult === undefined ? {} : { lastResult: exactResult(data.lastResult) }),
    ...(data.history === undefined ? {} : { history: data.history.map(exactResult) }),
    ...(data.lastMetrics === undefined ? {} : { lastMetrics: data.lastMetrics }),
    ...(data.lastError === undefined ? {} : { lastError: data.lastError }),
  }
}

function withoutActive(state: CurationState): CurationState {
  const { active: _active, ...remaining } = state
  return remaining
}

function appendHistory(state: CurationState, result: CurationResult): readonly CurationResult[] {
  return [...(state.history ?? []), result].slice(-50)
}

export function createCurationRepository(globalDir: string, namespace: string): CurationRepository {
  const curationRoot = join(globalDir, ".curation")
  const root = join(curationRoot, "projects", namespace)
  const paths = { root, runs: join(root, "runs"), state: join(root, "state.json"), settings: join(curationRoot, "settings.json") }
  const stateLock = join(root, "state.lock")
  const settingsLock = join(curationRoot, "settings.lock")
  const save = (state: CurationState) => writePrivate(globalDir, paths.state, `${JSON.stringify(state, null, 2)}\n`)
  const stateLocked = async <T>(work: () => Promise<T>): Promise<T> => {
    await ensurePrivateDir(globalDir, root)
    return withLock(stateLock, work)
  }
  return {
    paths,
    readState: () => loadState(globalDir, paths.state),
    paused: async () => {
      const decoded = await readJson(globalDir, paths.settings)
      if (decoded === undefined) return false
      const parsed = z.object({ version: z.literal(1), paused: z.boolean() }).strict().safeParse(decoded)
      if (!parsed.success) throw new TypeError(`curation settings are malformed: ${parsed.error.message}`)
      return parsed.data.paused
    },
    setPaused: async (paused) => {
      await ensurePrivateDir(globalDir, curationRoot)
      await withLock(settingsLock, () => writePrivate(globalDir, paths.settings, `${JSON.stringify({ version: 1, paused }, null, 2)}\n`))
    },
    reserve: (lease, metrics) => stateLocked(async () => {
      const state = await loadState(globalDir, paths.state)
      if (state.active !== undefined || state.recoveryBlocked !== undefined) return false
      if (state.lastResult?.runId === lease.runId || state.history?.some((result) => result.runId === lease.runId) === true) return false
      await ensurePrivateDir(globalDir, paths.runs)
      if (!(await createPrivateDirExclusive(globalDir, join(paths.runs, lease.runId)))) return false
      await save({ ...state, active: lease, lastMetrics: metrics, ...(lease.automatic ? { lastAutomaticAttemptAt: lease.startedAt } : {}) })
      return true
    }),
    attachChild: (runId, ownerToken, childSessionID) => stateLocked(async () => {
      const state = await loadState(globalDir, paths.state)
      if (state.active?.runId !== runId || state.active.ownerToken !== ownerToken || state.active.phase !== "reserved") throw new TypeError("curation lease ownership changed before child attachment")
      await save({ ...state, active: { ...state.active, childSessionID, phase: "dispatched" } })
    }),
    claim: (runId, ownerToken, from, to) => stateLocked(async () => {
      const state = await loadState(globalDir, paths.state)
      if (state.active?.runId !== runId || state.active.ownerToken !== ownerToken || state.active.phase !== from) return undefined
      const active = { ...state.active, phase: to }
      await save({ ...state, active })
      return active
    }),
    complete: (runId, ownerToken, result, success) => stateLocked(async () => {
      const state = await loadState(globalDir, paths.state)
      if (state.active?.runId !== runId || state.active.ownerToken !== ownerToken) throw new TypeError("curation lease ownership changed before completion")
      await save({ ...withoutActive(state), lastResult: result, history: appendHistory(state, result), ...(success === undefined ? {} : { lastSuccessAt: success.at, inventory: success.inventory }) })
    }),
    blockRecovery: (runId, message, at) => stateLocked(async () => {
      const state = await loadState(globalDir, paths.state)
      const base = withoutActive(state)
      await save({ ...base, recoveryBlocked: { runId, message, at }, lastError: { message, at } })
    }),
    recordError: (message, at) => stateLocked(async () => save({ ...(await loadState(globalDir, paths.state)), lastError: { at, message } })),
  }
}
