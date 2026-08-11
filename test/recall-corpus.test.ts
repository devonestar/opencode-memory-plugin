import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serializeMemory } from "../src/frontmatter"
import { buildPointerLine, type MemoryScope } from "../src/gate"
import {
  RECALL_MAX_TOPIC_BYTES,
  RecallCorpusIncompleteError,
  RecallCorpusUnreadableError,
  loadRecallCorpus,
  type RecallSource,
} from "../src/recall-corpus"
import { createStore, type MemoryStore } from "../src/store"

type TopicFixture = {
  readonly scope: MemoryScope
  readonly slug: string
  readonly description?: string
  readonly body?: string
  readonly name?: string
}

type SeedFixture = {
  readonly scope: MemoryScope
  readonly prefix: string
  readonly count: number
  readonly bodyChars?: number
}

let root: string
let dirs: Record<MemoryScope, string>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mem-recall-"))
  dirs = { global: join(root, "global"), project: join(root, "project") }
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { mode: 0o700 })))
})

afterEach(async () => {
  await Promise.all(Object.values(dirs).map((dir) => chmod(dir, 0o700)))
  await rm(root, { recursive: true, force: true })
})

function sources(): readonly RecallSource[] {
  return [
    { scope: "global", store: createStore(dirs.global) },
    { scope: "project", store: createStore(dirs.project) },
  ]
}

async function writeTopic(input: TopicFixture): Promise<void> {
  const description = input.description ?? `${input.slug} description`
  const raw = serializeMemory(
    { name: input.name ?? input.slug, description, type: "project" },
    input.body ?? `A durable clean memory body for ${input.slug}.`,
  )
  await writeFile(join(dirs[input.scope], `${input.slug}.md`), raw)
}

async function writeIndex(scope: MemoryScope, lines: readonly string[]): Promise<void> {
  await writeFile(join(dirs[scope], "MEMORY.md"), `${lines.join("\n")}\n`)
}

async function seed(input: SeedFixture): Promise<void> {
  const topics = Array.from({ length: input.count }, (_, index) => ({
    slug: `${input.prefix}-${index}`,
    description: `${input.prefix} description ${index}`,
  }))
  await Promise.all(topics.map(({ slug, description }) => writeTopic(input.bodyChars === undefined
    ? { scope: input.scope, slug, description }
    : { scope: input.scope, slug, description, body: "x".repeat(input.bodyChars) })))
  await writeIndex(input.scope, topics.map(({ slug, description }) => buildPointerLine(slug, description)))
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw new TypeError("expected an Error rejection")
  }
  throw new TypeError("expected promise to reject")
}

describe("loadRecallCorpus", () => {
  test("loads only canonical pointer targets and deduplicates within each scope", async () => {
    // Given two valid same-slug topics plus every skippable pointer target class
    await Promise.all([
      writeTopic({ scope: "global", slug: "shared", description: "global shared" }),
      writeTopic({ scope: "project", slug: "shared", description: "project shared" }),
      writeTopic({ scope: "global", slug: "orphan" }),
      writeTopic({ scope: "global", slug: "manual" }),
      writeTopic({ scope: "global", slug: "name-mismatch", name: "other-name" }),
      writeTopic({ scope: "global", slug: "description-mismatch", description: "topic description" }),
      writeTopic({ scope: "global", slug: "unsafe", description: "unsafe ``` description" }),
      writeTopic({ scope: "global", slug: "secret", body: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" }),
      writeTopic({ scope: "global", slug: "oversized", body: "x".repeat(33_000) }),
      writeFile(join(dirs.global, "malformed.md"), "not frontmatter"),
      mkdir(join(dirs.global, "non-regular.md")),
    ])
    await symlink(join(dirs.global, "shared.md"), join(dirs.global, "linked.md"))
    const globalPointers = [
      buildPointerLine("shared", "global shared"),
      buildPointerLine("shared", "global shared"),
      buildPointerLine("missing", "missing description"),
      buildPointerLine("linked", "linked description"),
      buildPointerLine("non-regular", "non-regular description"),
      buildPointerLine("malformed", "malformed description"),
      buildPointerLine("name-mismatch", "name-mismatch description"),
      buildPointerLine("description-mismatch", "pointer description"),
      buildPointerLine("unsafe", "unsafe ``` description"),
      buildPointerLine("secret", "secret description"),
      buildPointerLine("oversized", "oversized description"),
      buildPointerLine("../escape", "invalid slug"),
      "- [wrong-target](shared.md) — wrong target",
      "- [manual](manual.md) - noncanonical separator",
    ]
    await Promise.all([
      writeIndex("global", globalPointers),
      writeIndex("project", [buildPointerLine("shared", "project shared"), buildPointerLine("shared", "project shared")]),
    ])

    // When the selected stores are loaded
    const documents = await loadRecallCorpus(sources())

    // Then only one canonical document per scope and slug is returned
    expect(documents).toEqual([
      { scope: "global", slug: "shared", type: "project", description: "global shared", body: "A durable clean memory body for shared." },
      { scope: "project", slug: "shared", type: "project", description: "project shared", body: "A durable clean memory body for shared." },
    ])
  })

  test("does not enumerate or mutate store content and metadata", async () => {
    // Given directly readable stores whose directories cannot be enumerated
    await Promise.all([
      writeTopic({ scope: "global", slug: "stable" }),
      writeIndex("global", [buildPointerLine("stable", "stable description")]),
      writeIndex("project", []),
    ])
    await Promise.all(Object.values(dirs).map((dir) => chmod(dir, 0o300)))
    const paths = [dirs.global, dirs.project, join(dirs.global, "MEMORY.md"), join(dirs.project, "MEMORY.md"), join(dirs.global, "stable.md")]
    const contentPaths = paths.slice(2)
    const beforeContent = await Promise.all(contentPaths.map((path) => readFile(path)))
    const beforeMetadata = await Promise.all(paths.map(async (path) => {
      const info = await stat(path)
      return { mode: info.mode, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
    }))

    // When recall reads the corpus
    await loadRecallCorpus(sources())

    // Then no bytes or filesystem metadata changed
    expect(await Promise.all(contentPaths.map((path) => readFile(path)))).toEqual(beforeContent)
    expect(await Promise.all(paths.map(async (path) => {
      const info = await stat(path)
      return { mode: info.mode, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
    }))).toEqual(beforeMetadata)
  })

  test("rejects a truncated selected index as an incomplete corpus", async () => {
    // Given a selected index that reports truncation
    const store: MemoryStore = {
      ...createStore(dirs.global),
      readIndexForInjection: async () => ({ content: buildPointerLine("hidden", "hidden description"), truncated: true }),
    }

    // When the corpus is loaded
    const error = await rejection(loadRecallCorpus([{ scope: "global", store }]))

    // Then the caller receives a typed, sanitized incomplete error
    expect(error).toBeInstanceOf(RecallCorpusIncompleteError)
    expect(error).toMatchObject({ reason: "truncated-index" })
    expect(error.message).not.toContain("hidden")
  })

  test("sanitizes failures while reading a selected index", async () => {
    // Given a store failure containing a path and secret-like detail
    const leak = `${dirs.global}/MEMORY.md token=supersecretvalue`
    const store: MemoryStore = { ...createStore(dirs.global), readIndexForInjection: async () => { throw new Error(leak) } }

    // When the corpus is loaded
    const error = await rejection(loadRecallCorpus([{ scope: "global", store }]))

    // Then only typed scope and stage information crosses the boundary
    expect(error).toBeInstanceOf(RecallCorpusUnreadableError)
    expect(error).toMatchObject({ scope: "global", stage: "index" })
    expect(error.message).not.toContain(leak)
  })

  test("rejects more than 200 valid documents", async () => {
    // Given 201 valid canonical topics across selected stores
    await Promise.all([
      seed({ scope: "global", prefix: "global", count: 101 }),
      seed({ scope: "project", prefix: "project", count: 100 }),
    ])

    // When the corpus is loaded
    const error = await rejection(loadRecallCorpus(sources()))

    // Then partial results are rejected as incomplete
    expect(error).toBeInstanceOf(RecallCorpusIncompleteError)
    expect(error).toMatchObject({ reason: "topic-limit" })
  })

  test("rejects more than 512 KiB of valid documents", async () => {
    // Given individually bounded topics whose aggregate exceeds the corpus bound
    await seed({ scope: "global", prefix: "large", count: 17, bodyChars: 31_000 })
    await writeIndex("project", [])

    // When the corpus is loaded
    const error = await rejection(loadRecallCorpus(sources()))

    // Then partial results are rejected as incomplete
    expect(error).toBeInstanceOf(RecallCorpusIncompleteError)
    expect(error).toMatchObject({ reason: "byte-limit" })
  })

  test("skips an oversized sparse topic and continues with later pointers", async () => {
    // Given an oversized sparse topic before a valid canonical topic
    const oversizedPath = join(dirs.global, "sparse.md")
    const oversized = await open(oversizedPath, "w")
    await oversized.truncate(8 * 1024 * 1024 * 1024)
    await oversized.close()
    await writeTopic({ scope: "global", slug: "retained" })
    await Promise.all([
      writeIndex("global", [buildPointerLine("sparse", "sparse description"), buildPointerLine("retained", "retained description")]),
      writeIndex("project", []),
    ])

    // When recall loads the selected corpus
    const documents = await loadRecallCorpus(sources())

    // Then the oversized topic is skipped without preventing later recall
    expect(documents.map(({ slug }) => slug)).toEqual(["retained"])
  })
})
