import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  CURATION_SUGGESTION_MAX_BYTES,
  createCurationSuggestionRepository,
  suggestionFingerprint,
} from "../src/curation-suggestions"
import { LockTimeoutError, withLock } from "../src/fsutil"
import { parseProposal, type ProposalOperation, type ProposalSource } from "../src/proposal"

const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-curation-suggestions-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function source(slug: string, sha256: string = HASH_A): ProposalSource {
  return { scope: "global", slug, sha256 }
}

function rewrite(id: string, sources: readonly ProposalSource[], body: string = "Replacement body"): ProposalOperation {
  return {
    id,
    kind: "REWRITE",
    confidence: "high",
    reasonCode: "description-shape",
    sources,
    replacement: { scope: "project", slug: "destination", type: "project", description: "Replacement description", body },
  }
}

describe("curation suggestion fingerprints", () => {
  test("collapse run and operation locators while retaining full replacement sensitivity", () => {
    // Given equivalent operations with different excluded fields and source order
    const first = rewrite("first", [source("beta", HASH_B), source("alpha", HASH_A)])
    const second = { ...rewrite("second", [source("alpha", HASH_A), source("beta", HASH_B)]), confidence: "low" as const }

    // When their fingerprints are calculated
    const fingerprints = [suggestionFingerprint(first), suggestionFingerprint(second), suggestionFingerprint(rewrite("third", first.sources, "Changed body"))]

    // Then locators and confidence do not affect identity, but replacement content does
    expect(fingerprints[0]).toBe(fingerprints[1])
    expect(fingerprints[2]).not.toBe(fingerprints[0])
    expect(fingerprints[0]).toBe("bd3476c036f7400058ddc0dd35d3d601ae91871e5d8c2493d877f395c0995337")
  })
})

describe("curation suggestion repository", () => {
  test("treats a missing file as an empty inbox", async () => {
    // Given a repository whose namespace root does not exist
    const repository = createCurationSuggestionRepository(dir, "project-abc")

    // When the inbox is listed
    const entries = await repository.list()

    // Then no file is required to represent an empty inbox
    expect(entries).toEqual([])
  })

  test("deduplicates suggestions and persists only bounded metadata", async () => {
    // Given one repository and two equivalent operations from different runs
    const repository = createCurationSuggestionRepository(dir, "project-abc")
    const operation = rewrite("old-operation", [source("alpha")], "Secret replacement body")

    // When the equivalent suggestion is added again with newer locators
    await repository.add({ runId: "old-run", operation, at: 10 })
    const updated = await repository.add({ runId: "new-run", operation: { ...operation, id: "new-operation", confidence: "medium" }, at: 20 })

    // Then one entry remains with latest locators and no replacement content on disk
    const raw = await readFile(repository.paths.inbox, "utf8")
    expect(await repository.list()).toEqual([updated])
    expect(updated).toMatchObject({ runId: "new-run", operationId: "new-operation", createdAt: 10, updatedAt: 20 })
    expect(raw).not.toContain("Secret replacement body")
    expect(raw).not.toContain("Replacement description")
  })

  test("serializes concurrent writers under the local lock", async () => {
    // Given independent suggestions targeting the same namespace
    const repository = createCurationSuggestionRepository(dir, "project-abc")
    const additions = Array.from({ length: 20 }, (_, index) => ({
      runId: `run-${index}`,
      operation: rewrite(`operation-${index}`, [source(`source-${index}`, index.toString(16).padStart(64, "0"))]),
      at: index,
    }))

    // When all writers race
    await Promise.all(additions.map((addition) => repository.add(addition)))

    // Then every unique entry survives atomic read-modify-write
    expect(await repository.list()).toHaveLength(20)
  })

  test("evicts deterministically to the newest 200 entries", async () => {
    // Given more unique suggestions than the inbox bound
    const repository = createCurationSuggestionRepository(dir, "project-abc")
    for (let index = 0; index < 201; index += 1) {
      await repository.add({
        runId: `run-${index}`,
        operation: rewrite(`operation-${index}`, [source(`source-${index}`, index.toString(16).padStart(64, "0"))]),
        at: index,
      })
    }

    // When the bounded inbox is listed
    const entries = await repository.list()

    // Then the deterministic oldest entry was evicted
    expect(entries).toHaveLength(200)
    expect(entries.some((entry) => entry.runId === "run-0")).toBeFalse()
    expect(entries[0]?.runId).toBe("run-1")
  })

  test("claims the oldest entry and preserves the remaining inbox", async () => {
    // Given three advisory suggestions in creation order
    const repository = createCurationSuggestionRepository(dir, "project-abc")
    await repository.add({ runId: "oldest-run", operation: rewrite("oldest", [source("oldest", HASH_A)]), at: 1 })
    await repository.add({ runId: "middle-run", operation: rewrite("middle", [source("middle", HASH_B)]), at: 2 })
    await repository.add({ runId: "newest-run", operation: rewrite("newest", [source("newest", HASH_A)]), at: 3 })

    // When one suggestion is claimed
    const claimed = await repository.claim(1, () => true)

    // Then the oldest is consumed and later entries remain ordered
    expect(claimed.map((entry) => entry.runId)).toEqual(["oldest-run"])
    expect((await repository.list()).map((entry) => entry.runId)).toEqual(["middle-run", "newest-run"])
  })

  test("claims the largest oldest prefix accepted by the renderer", async () => {
    // Given three advisory suggestions and a renderer that can retain only two
    const repository = createCurationSuggestionRepository(dir, "project-abc")
    await repository.add({ runId: "oldest-run", operation: rewrite("oldest", [source("oldest")]), at: 1 })
    await repository.add({ runId: "middle-run", operation: rewrite("middle", [source("middle")]), at: 2 })
    await repository.add({ runId: "newest-run", operation: rewrite("newest", [source("newest")]), at: 3 })

    // When the claim tests candidate prefixes from three down to one
    const tested: number[] = []
    const claimed = await repository.claim(3, (candidate) => {
      tested.push(candidate.length)
      return candidate.length <= 2
    })

    // Then the largest fitting oldest prefix is consumed and the newest remains
    expect(tested).toEqual([3, 2])
    expect(claimed.map((entry) => entry.runId)).toEqual(["oldest-run", "middle-run"])
    expect((await repository.list()).map((entry) => entry.runId)).toEqual(["newest-run"])
  })

  test.each(["missing", "empty"])("returns from a %s inbox without acquiring the busy lock", async (state) => {
    // Given a missing or explicitly empty inbox while another process holds its lock
    const repository = createCurationSuggestionRepository(dir, "project-abc")
    await mkdir(dirname(repository.paths.inbox), { recursive: true, mode: 0o700 })
    if (state === "empty") await writeFile(repository.paths.inbox, `${JSON.stringify({ version: 1, entries: [] })}\n`, { mode: 0o600 })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holder = withLock(repository.paths.lock, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise

    // When injection checks the inbox
    let claimed: readonly unknown[] = []
    try {
      claimed = await repository.claim(3, () => true)
    } finally {
      release.resolve()
      await holder
    }

    // Then it returns empty without contending on or writing through the lock
    expect(claimed).toEqual([])
  })

  test("fails a claim immediately while the suggestion lock is held", async () => {
    // Given one suggestion and a real live holder of its repository lock
    const repository = createCurationSuggestionRepository(dir, "project-abc")
    await repository.add({ runId: "preserved-run", operation: rewrite("preserved", [source("preserved")]), at: 1 })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holder = withLock(repository.paths.lock, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise

    // When an ordinary injection attempts to claim from the busy inbox
    const claim = repository.claim(1, () => true).then(
      () => ({ kind: "fulfilled" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    )
    const outcome = await Promise.race([
      claim,
      Bun.sleep(50).then(() => ({ kind: "waiting" as const })),
    ])
    release.resolve()
    await holder
    await claim

    // Then contention is reported without waiting or consuming the suggestion
    expect(outcome.kind).toBe("rejected")
    expect(outcome.kind === "rejected" ? outcome.error : undefined).toBeInstanceOf(LockTimeoutError)
    expect(await repository.list()).toHaveLength(1)
  })

  test.each([0, -1, 1.5, 11, Number.NaN])("rejects invalid claim limit %p without mutating the inbox", async (limit) => {
    // Given a non-empty inbox and an invalid claim limit
    const repository = createCurationSuggestionRepository(dir, "project-abc")
    await repository.add({ runId: "preserved-run", operation: rewrite("preserved", [source("preserved")]), at: 1 })
    const before = await repository.list()

    // When the invalid limit is claimed
    const claim = repository.claim(limit, () => true)

    // Then validation rejects the claim and preserves every entry
    await expect(claim).rejects.toThrow("claim limit")
    expect(await repository.list()).toEqual(before)
  })

  test("rejects malformed persisted inboxes instead of overwriting them", async () => {
    // Given a schema-invalid inbox file
    const repository = createCurationSuggestionRepository(dir, "project-abc")
    await mkdir(dirname(repository.paths.inbox), { recursive: true, mode: 0o700 })
    await writeFile(repository.paths.inbox, `${JSON.stringify({ version: 1, entries: [], unexpected: true })}\n`, { mode: 0o600 })

    // When a mutation attempts to load the file
    const mutation = repository.add({ runId: "run", operation: rewrite("operation", [source("alpha")]), at: 1 })

    // Then strict boundary parsing rejects it without replacement
    await expect(mutation).rejects.toThrow("curation suggestion inbox is malformed")
    expect(await readFile(repository.paths.inbox, "utf8")).toContain("unexpected")
  })

  test("rejects persisted inboxes above the byte bound", async () => {
    // Given an inbox file larger than the strict JSON byte limit
    const repository = createCurationSuggestionRepository(dir, "project-abc")
    await mkdir(dirname(repository.paths.inbox), { recursive: true, mode: 0o700 })
    await writeFile(repository.paths.inbox, " ".repeat(CURATION_SUGGESTION_MAX_BYTES + 1), { mode: 0o600 })

    // When the oversized inbox is listed
    const listing = repository.list()

    // Then the repository fails closed before parsing its contents
    await expect(listing).rejects.toThrow("file exceeds byte limit")
  })

  test("accepts every proposal-valid slug and reason shape in the persisted inbox", async () => {
    // Given a proposal with source/destination slugs and a reason beyond the inbox's former 100-character caps
    const longSlug = `topic-${"s".repeat(140)}`
    const longReason = `reason-${"r".repeat(140)}`
    const operation = parseProposal(JSON.stringify({
      version: 1,
      snapshotSha256: HASH_A,
      operations: [{
        id: "operation",
        kind: "REWRITE",
        confidence: "high",
        reasonCode: longReason,
        sources: [{ scope: "global", slug: longSlug, sha256: HASH_B }],
        replacement: { scope: "project", slug: longSlug, type: "project", description: "description", body: "body" },
      }],
      findings: [],
      summary: { reviewed: 1, highConfidence: 1, ambiguous: 0 },
    })).operations[0]
    if (operation === undefined) throw new TypeError("proposal fixture omitted its operation")
    const repository = createCurationSuggestionRepository(dir, "project-abc")

    // When the proposal-valid operation crosses the inbox boundary
    await repository.add({ runId: "run", operation, at: 1 })

    // Then the inbox preserves the same accepted values
    expect(await repository.list()).toMatchObject([{ reasonCode: longReason, sources: [{ slug: longSlug }], destination: { slug: longSlug } }])
  })
})
