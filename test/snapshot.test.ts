import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import { serializeMemory } from "../src/frontmatter"
import { SnapshotError, captureSnapshot } from "../src/snapshot"

let dir: string
let stores: { readonly global: string; readonly project: string }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-curation-snapshot-"))
  stores = { global: join(dir, "global"), project: join(dir, "project") }
  await Promise.all([mkdir(stores.global, { mode: 0o700 }), mkdir(stores.project, { mode: 0o700 })])
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function topic(scope: "global" | "project", slug: string, body = "A durable clean memory body for curation."): Promise<void> {
  const raw = serializeMemory({ name: slug, description: `${slug} description`, type: "project" }, body)
  await writeFile(join(stores[scope], `${slug}.md`), raw)
  await writeFile(join(stores[scope], "MEMORY.md"), `- [${slug}](${slug}.md) — ${slug} description\n`, { flag: "a" })
}

describe("curation snapshot", () => {
  test("has a deterministic digest independent of file creation order and mtimes", async () => {
    // Given equal stores assembled in different orders
    await topic("global", "alpha")
    await topic("project", "beta")
    const first = await captureSnapshot(stores, DEFAULT_CURATION_CONFIG)
    await rm(stores.global, { recursive: true })
    await rm(stores.project, { recursive: true })
    await Promise.all([mkdir(stores.global, { mode: 0o700 }), mkdir(stores.project, { mode: 0o700 })])
    await topic("project", "beta")
    await topic("global", "alpha")

    // When the equivalent store is captured again
    const second = await captureSnapshot(stores, DEFAULT_CURATION_CONFIG)

    // Then canonical content produces the same digest and order
    expect(second.sha256).toBe(first.sha256)
    expect(second.topics.map((item) => `${item.scope}:${item.slug}`)).toEqual(["global:alpha", "project:beta"])
  })

  test("rejects a direct topic symlink", async () => {
    // Given a valid topic reached through a second symlinked slug
    await topic("global", "real-topic")
    await symlink(join(stores.global, "real-topic.md"), join(stores.global, "linked-topic.md"))

    // When and Then the store is captured
    await expect(captureSnapshot(stores, DEFAULT_CURATION_CONFIG)).rejects.toBeInstanceOf(SnapshotError)
  })

  test("rejects symlink swaps after discovery but before open", async () => {
    await topic("global", "racy")
    await writeFile(join(dir, "index-target.md"), "- [racy](racy.md) — racy description\n")
    await writeFile(join(dir, "topic-target.md"), "---\nname: racy\ndescription: racy description\nmetadata:\n  type: project\n---\n\nA durable clean memory body for curation.\n")
    const indexReady = Promise.withResolvers<void>()
    const topicReady = Promise.withResolvers<void>()
    const releaseIndex = Promise.withResolvers<void>()
    const releaseTopic = Promise.withResolvers<void>()

    const snapshot = captureSnapshot(stores, DEFAULT_CURATION_CONFIG, async (checkpoint) => {
      if (checkpoint.scope !== "global") return
      if (checkpoint.phase === "before-index-open") {
        indexReady.resolve()
        await releaseIndex.promise
        return
      }
      if (checkpoint.phase === "before-topic-open" && checkpoint.slug === "racy") {
        topicReady.resolve()
        await releaseTopic.promise
      }
    })
    await Promise.all([indexReady.promise, topicReady.promise])
    await rm(join(stores.global, "MEMORY.md"))
    await symlink(join(dir, "index-target.md"), join(stores.global, "MEMORY.md"))
    await rm(join(stores.global, "racy.md"))
    await symlink(join(dir, "topic-target.md"), join(stores.global, "racy.md"))
    releaseIndex.resolve()
    releaseTopic.resolve()

    await expect(snapshot).rejects.toBeInstanceOf(SnapshotError)
  })

  test("rejects malformed frontmatter and mismatched names", async () => {
    // Given malformed global and mismatched project topics
    await writeFile(join(stores.global, "broken.md"), "not frontmatter")

    // When and Then malformed content is captured
    await expect(captureSnapshot(stores, DEFAULT_CURATION_CONFIG)).rejects.toThrow("malformed")
  })

  test("rejects secrets before dispatching any partial snapshot", async () => {
    // Given one clean topic and one secret-bearing topic
    await topic("global", "clean-topic")
    await topic("project", "secret-topic", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456")

    // When and Then the whole snapshot is captured
    await expect(captureSnapshot(stores, DEFAULT_CURATION_CONFIG)).rejects.toThrow("secret")
  })

  test.each([
    ["topic count", { maxTopics: 1 }, async () => Promise.all([topic("global", "one"), topic("project", "two")])],
    ["per-topic bytes", { maxTopicBytes: 100 }, async () => topic("global", "large", "x".repeat(200))],
    ["total input bytes", { maxInputBytes: 100 }, async () => topic("global", "total", "x".repeat(200))],
  ])("rejects the %s bound", async (_label, override, arrange) => {
    // Given content beyond one configured bound
    await arrange()
    const config = { ...DEFAULT_CURATION_CONFIG, ...override }

    // When and Then the store is captured
    await expect(captureSnapshot(stores, config)).rejects.toBeInstanceOf(SnapshotError)
  })

  test("ignores indexes, locks, dot entries, and nested topic files", async () => {
    // Given one direct topic plus excluded filesystem entries
    await topic("global", "direct-topic")
    await writeFile(join(stores.global, "MEMORY.md.lock"), "owner")
    await writeFile(join(stores.global, ".hidden.md"), "hidden")
    await mkdir(join(stores.global, "nested"))
    await topic("project", "project-topic")
    await writeFile(join(stores.global, "nested", "nested.md"), "ignored")

    // When the snapshot is captured
    const snapshot = await captureSnapshot(stores, DEFAULT_CURATION_CONFIG)

    // Then only direct regular topic files are included while raw index metadata is retained
    expect(snapshot.topics.map((item) => item.slug)).toEqual(["direct-topic", "project-topic"])
    expect(snapshot.indexes.find((index) => index.scope === "global")?.raw).toBe("- [direct-topic](direct-topic.md) — direct-topic description\n")
  })

  test.each([
    ["malformed", "not a pointer\n"],
    ["duplicate", "- [alpha](alpha.md) — alpha description\n- [alpha](alpha.md) — alpha description\n"],
    ["dangling", "- [alpha](alpha.md) — alpha description\n- [missing](missing.md) — missing description\n"],
    ["description mismatch", "- [alpha](alpha.md) — different description\n"],
    ["missing topic pointer", ""],
  ])("retains an inconsistent index for deterministic apply-time repair: %s", async (_label, index) => {
    await topic("global", "alpha")
    await writeFile(join(stores.global, "MEMORY.md"), index)

    const snapshot = await captureSnapshot(stores, DEFAULT_CURATION_CONFIG)
    expect(snapshot.indexes.find((candidate) => candidate.scope === "global")?.raw).toBe(index)
  })
})
