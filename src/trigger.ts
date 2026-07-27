import type { CurationConfig } from "./curation-config"
import { INDEX_MAX_BYTES } from "./config"
import type { MemorySnapshot } from "./snapshot"

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

export type CurationHistory = {
  readonly lastSuccessAt?: number
  readonly lastAutomaticAttemptAt?: number
  readonly inventory?: Readonly<Record<string, string>>
}

export type TriggerMetrics = {
  readonly topics: number
  readonly oldestTopicAgeDays: number | null
  readonly lastSuccessAgeDays: number | null
  readonly largestIndexBytes: number
  readonly indexRatio: number
  readonly changedTopics: number
}

export type Eligibility = {
  readonly eligible: boolean
  readonly reasons: readonly string[]
  readonly blockedBy?: "disabled" | "paused" | "empty" | "cooldown" | "thresholds"
  readonly nextEligibleAt: number | null
  readonly metrics: TriggerMetrics
}

export type EligibilityInput = {
  readonly snapshot: MemorySnapshot
  readonly history: CurationHistory
  readonly config: CurationConfig
  readonly now: number
  readonly paused?: boolean
  readonly force?: boolean
}

function changedTopics(snapshot: MemorySnapshot, previous: Readonly<Record<string, string>> | undefined): number {
  const current = new Map(snapshot.topics.map((topic) => [`${topic.scope}:${topic.slug}`, topic.sha256]))
  if (previous === undefined) return current.size
  let changed = 0
  for (const [key, hash] of current) if (previous[key] !== hash) changed += 1
  for (const key of Object.keys(previous)) if (!current.has(key)) changed += 1
  return changed
}

export function snapshotInventory(snapshot: MemorySnapshot): Readonly<Record<string, string>> {
  return Object.fromEntries(snapshot.topics.map((topic) => [`${topic.scope}:${topic.slug}`, topic.sha256]))
}

export function evaluateEligibility(input: EligibilityInput): Eligibility {
  const largestIndexBytes = Math.max(...input.snapshot.indexes.map((index) => index.bytes), 0)
  const oldestTopicAgeDays = input.snapshot.oldestTopicMtimeMs === null ? null : (input.now - input.snapshot.oldestTopicMtimeMs) / DAY_MS
  const lastSuccessAgeDays = input.history.lastSuccessAt === undefined ? null : (input.now - input.history.lastSuccessAt) / DAY_MS
  const changed = changedTopics(input.snapshot, input.history.inventory)
  const metrics = {
    topics: input.snapshot.topics.length,
    oldestTopicAgeDays,
    lastSuccessAgeDays,
    largestIndexBytes,
    indexRatio: largestIndexBytes / INDEX_MAX_BYTES,
    changedTopics: changed,
  }
  if (!input.config.enabled) return { eligible: false, reasons: [], blockedBy: "disabled", nextEligibleAt: null, metrics }
  if (input.paused === true) return { eligible: false, reasons: [], blockedBy: "paused", nextEligibleAt: null, metrics }
  if (input.snapshot.topics.length === 0) return { eligible: false, reasons: [], blockedBy: "empty", nextEligibleAt: null, metrics }

  const cooldownUntil = input.history.lastAutomaticAttemptAt === undefined ? null : input.history.lastAutomaticAttemptAt + input.config.cooldownHours * HOUR_MS
  if (input.force !== true && cooldownUntil !== null && input.now < cooldownUntil) {
    return { eligible: false, reasons: [], blockedBy: "cooldown", nextEligibleAt: cooldownUntil, metrics }
  }
  if (input.force === true) return { eligible: true, reasons: ["manual-force"], nextEligibleAt: input.now, metrics }

  const reasons: string[] = []
  if (lastSuccessAgeDays !== null && lastSuccessAgeDays >= input.config.maxAgeDays) reasons.push("success-age")
  if (input.history.lastSuccessAt === undefined && oldestTopicAgeDays !== null && oldestTopicAgeDays >= input.config.maxAgeDays) reasons.push("oldest-topic-age")
  if (metrics.indexRatio >= input.config.indexRatio) reasons.push("index-ratio")
  if (changed >= input.config.changedTopics) reasons.push("changed-topics")
  if (reasons.length > 0) return { eligible: true, reasons, nextEligibleAt: input.now, metrics }

  const ageDue = input.history.lastSuccessAt === undefined
    ? input.snapshot.oldestTopicMtimeMs === null ? null : input.snapshot.oldestTopicMtimeMs + input.config.maxAgeDays * DAY_MS
    : input.history.lastSuccessAt + input.config.maxAgeDays * DAY_MS
  return { eligible: false, reasons, blockedBy: "thresholds", nextEligibleAt: ageDue, metrics }
}
