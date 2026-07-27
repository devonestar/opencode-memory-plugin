import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import type { MemoryScope } from "../src/gate"
import { serializeMemory, type MemoryType } from "../src/frontmatter"
import { captureSnapshot, type MemorySnapshot } from "../src/snapshot"

export type TestStores = {
  readonly global: string
  readonly project: string
}

export async function createTestStores(root: string): Promise<TestStores> {
  const stores = { global: join(root, "a-global"), project: join(root, "b-project") }
  await Promise.all([mkdir(stores.global, { recursive: true, mode: 0o700 }), mkdir(stores.project, { recursive: true, mode: 0o700 })])
  return stores
}

export async function writeTopic(
  stores: TestStores,
  input: {
    readonly scope: MemoryScope
    readonly slug: string
    readonly description?: string
    readonly type?: MemoryType
    readonly body?: string
  },
): Promise<void> {
  const description = input.description ?? `${input.slug} description`
  const body = input.body ?? `This is the durable body for ${input.slug}.`
  const raw = serializeMemory({ name: input.slug, description, type: input.type ?? "project" }, body)
  await writeFile(join(stores[input.scope], `${input.slug}.md`), raw)
  await writeFile(join(stores[input.scope], "MEMORY.md"), `- [${input.slug}](${input.slug}.md) — ${description}\n`, { flag: "a" })
}

export async function testSnapshot(stores: TestStores): Promise<MemorySnapshot> {
  return captureSnapshot(stores, DEFAULT_CURATION_CONFIG)
}

export function source(snapshot: MemorySnapshot, scope: MemoryScope, slug: string) {
  const topic = snapshot.topics.find((candidate) => candidate.scope === scope && candidate.slug === slug)
  if (topic === undefined) throw new TypeError(`missing fixture topic ${scope}:${slug}`)
  return { scope, slug, sha256: topic.sha256 }
}

export function proposal(snapshot: MemorySnapshot, operations: readonly Record<string, unknown>[]) {
  return {
    version: 1,
    snapshotSha256: snapshot.sha256,
    operations,
    findings: [],
    summary: {
      reviewed: snapshot.topics.length,
      highConfidence: operations.filter((operation) => operation["confidence"] === "high").length,
      ambiguous: operations.filter((operation) => operation["confidence"] !== "high").length,
    },
  }
}
