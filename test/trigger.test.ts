import { describe, expect, test } from "bun:test"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import type { MemorySnapshot } from "../src/snapshot"
import { evaluateEligibility } from "../src/trigger"

const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 26)

function snapshot(input: { readonly topics?: number; readonly oldest?: number; readonly indexBytes?: number } = {}): MemorySnapshot {
  const count = input.topics ?? 1
  return {
    version: 1,
    sha256: "a".repeat(64),
    totalBytes: 100,
    oldestTopicMtimeMs: input.oldest ?? NOW,
    topics: Array.from({ length: count }, (_, index) => ({
      scope: "global" as const,
      slug: `topic-${index}`,
      sha256: String(index).padStart(64, "0"),
      bytes: 50,
      mtimeMs: NOW,
      type: "project" as const,
      description: `topic ${index}`,
      body: "durable body",
    })),
    indexes: [
      { scope: "global", sha256: "b".repeat(64), bytes: input.indexBytes ?? 0, raw: "" },
      { scope: "project", sha256: "c".repeat(64), bytes: 0, raw: "" },
    ],
  }
}

describe("automatic curation eligibility", () => {
  test("triggers when the last success is at least the configured age", () => {
    const result = evaluateEligibility({ snapshot: snapshot(), history: { lastSuccessAt: NOW - 30 * DAY, inventory: {} }, config: DEFAULT_CURATION_CONFIG, now: NOW })
    expect(result.eligible).toBe(true)
    expect(result.reasons).toContain("success-age")
  })

  test("triggers on the oldest topic age when no success exists", () => {
    const result = evaluateEligibility({ snapshot: snapshot({ oldest: NOW - 31 * DAY }), history: {}, config: DEFAULT_CURATION_CONFIG, now: NOW })
    expect(result.reasons).toContain("oldest-topic-age")
  })

  test("triggers at seventy percent of the 25KB raw index cap", () => {
    const result = evaluateEligibility({ snapshot: snapshot({ indexBytes: 17_500 }), history: {}, config: DEFAULT_CURATION_CONFIG, now: NOW })
    expect(result.reasons).toContain("index-ratio")
  })

  test("counts added, changed, and removed inventory hashes", () => {
    const current = snapshot({ topics: 10 })
    const inventory = Object.fromEntries(current.topics.map((topic, index) => [`${topic.scope}:${topic.slug}`, index === 0 ? "old" : topic.sha256]))
    inventory["global:removed"] = "gone"
    const config = { ...DEFAULT_CURATION_CONFIG, changedTopics: 2 }

    const result = evaluateEligibility({ snapshot: current, history: { inventory }, config, now: NOW })

    expect(result.metrics.changedTopics).toBe(2)
    expect(result.reasons).toContain("changed-topics")
  })

  test("honors automatic cooldown even when a threshold is met", () => {
    const history = { lastSuccessAt: NOW - 60 * DAY, lastAutomaticAttemptAt: NOW - 2 * 60 * 60 * 1000, inventory: {} }
    const result = evaluateEligibility({ snapshot: snapshot(), history, config: DEFAULT_CURATION_CONFIG, now: NOW })
    expect(result.eligible).toBe(false)
    expect(result.blockedBy).toBe("cooldown")
  })

  test("manual force bypasses thresholds and cooldown but not pause, disable, or empty stores", () => {
    const history = { lastAutomaticAttemptAt: NOW, inventory: {} }
    expect(evaluateEligibility({ snapshot: snapshot(), history, config: DEFAULT_CURATION_CONFIG, now: NOW, force: true }).eligible).toBe(true)
    expect(evaluateEligibility({ snapshot: snapshot(), history, config: DEFAULT_CURATION_CONFIG, now: NOW, force: true, paused: true }).eligible).toBe(false)
    expect(evaluateEligibility({ snapshot: snapshot(), history, config: { ...DEFAULT_CURATION_CONFIG, enabled: false }, now: NOW, force: true }).eligible).toBe(false)
    expect(evaluateEligibility({ snapshot: snapshot({ topics: 0 }), history, config: DEFAULT_CURATION_CONFIG, now: NOW, force: true }).eligible).toBe(false)
  })
})
