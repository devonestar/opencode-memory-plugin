import { createHash } from "node:crypto"
import { join } from "node:path"
import { buildPointerLine } from "./gate"
import type { ProposalValidation } from "./proposal"
import type { MemoryType } from "./frontmatter"
import { snapshotSha256, type CurationStores, type MemorySnapshot, type SnapshotIndex, type SnapshotScope } from "./snapshot"

export type PlanTopic = { readonly scope: SnapshotScope; readonly slug: string; readonly sha256: string; readonly type: MemoryType; readonly description: string; readonly body: string }
export type ApplyPlan = {
  readonly sources: readonly PlanTopic[]
  readonly survivors: readonly PlanTopic[]
  readonly removals: readonly PlanTopic[]
  readonly indexPreimages: Readonly<Record<SnapshotScope, string>>
  readonly indexes: Readonly<Record<SnapshotScope, string>>
  readonly expectedPostSnapshotSha256: string
}

function topicKey(scope: SnapshotScope, slug: string): string {
  return `${scope}:${slug}`
}

export function createApplyPlan(snapshot: MemorySnapshot, validation: ProposalValidation): ApplyPlan {
  const sources = new Map<string, PlanTopic>()
  const survivors = new Map<string, PlanTopic>()
  const removals = new Map<string, PlanTopic>()
  for (const operation of validation.applicable) {
    if (operation.kind !== "MERGE") throw new TypeError("automatic apply accepts exact MERGE operations only")
    const survivorKey = topicKey(operation.replacement.scope, operation.replacement.slug)
    for (const source of operation.sources) {
      const key = topicKey(source.scope, source.slug)
      const topic = snapshot.topics.find((candidate) => topicKey(candidate.scope, candidate.slug) === key)
      if (topic === undefined) throw new TypeError(`apply source is absent from snapshot: ${key}`)
      const planned = { scope: topic.scope, slug: topic.slug, sha256: topic.sha256, type: topic.type, description: topic.description, body: topic.body }
      sources.set(key, planned)
      if (key === survivorKey) survivors.set(key, planned)
      else removals.set(key, planned)
    }
  }
  const indexes = {
    global: nextIndex("global", snapshot, removals),
    project: nextIndex("project", snapshot, removals),
  }
  const indexPreimages = {
    global: indexHash(snapshot, "global"),
    project: indexHash(snapshot, "project"),
  }
  const base = { sources: [...sources.values()], survivors: [...survivors.values()], removals: [...removals.values()], indexPreimages, indexes }
  return { ...base, expectedPostSnapshotSha256: projectedDigest(snapshot, base.removals, indexes) }
}

function indexHash(snapshot: MemorySnapshot, scope: SnapshotScope): string {
  return snapshot.indexes.find((index) => index.scope === scope)?.sha256 ?? createHash("sha256").update("").digest("hex")
}

function projectedDigest(snapshot: MemorySnapshot, removals: readonly PlanTopic[], indexes: Readonly<Record<SnapshotScope, string>>): string {
  const removed = new Set(removals.map((topic) => topicKey(topic.scope, topic.slug)))
  const topics = snapshot.topics.filter((topic) => !removed.has(topicKey(topic.scope, topic.slug)))
  const projectedIndexes: SnapshotIndex[] = (["global", "project"] as const).map((scope) => {
    const raw = indexes[scope]
    return { scope, sha256: createHash("sha256").update(raw).digest("hex"), bytes: Buffer.byteLength(raw), raw }
  })
  return snapshotSha256(topics, projectedIndexes)
}

function nextIndex(scope: SnapshotScope, snapshot: MemorySnapshot, removals: ReadonlyMap<string, PlanTopic>): string {
  const topics = new Map(snapshot.topics.filter((topic) => topic.scope === scope).map((topic) => [topic.slug, topic.description]))
  for (const removal of removals.values()) if (removal.scope === scope) topics.delete(removal.slug)
  const raw = snapshot.indexes.find((index) => index.scope === scope)?.raw ?? ""
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const line of raw.split("\n")) {
    const slug = line.match(/^- \[([a-z0-9][a-z0-9-]*)\]\(\1\.md\) — /)?.[1]
    if (slug === undefined || seen.has(slug) || !topics.has(slug)) continue
    seen.add(slug)
    ordered.push(slug)
  }
  const missing = [...topics.keys()].filter((slug) => !seen.has(slug)).sort((left, right) => left.localeCompare(right))
  const lines = [...ordered, ...missing].map((slug) => buildPointerLine(slug, topics.get(slug) ?? ""))
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}

export function topicPath(stores: CurationStores, scope: SnapshotScope, slug: string): string {
  return join(stores[scope], `${slug}.md`)
}
