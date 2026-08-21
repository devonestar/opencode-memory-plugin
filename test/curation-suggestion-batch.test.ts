import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createCurationSuggestionRepository,
  recordCurationSuggestions,
  suggestionFingerprint,
  type AddCurationSuggestion,
} from "../src/curation-suggestions"
import { parseProposal, type ProposalOperation, type ProposalSource } from "../src/proposal"

const HASH_A = "a".repeat(64)
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-curation-suggestion-batch-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function source(slug: string, sha256: string = HASH_A): ProposalSource {
  return { scope: "global", slug, sha256 }
}

function rewrite(id: string, sources: readonly ProposalSource[]): ProposalOperation {
  return {
    id,
    kind: "REWRITE",
    confidence: "high",
    reasonCode: "description-shape",
    sources,
    replacement: { scope: "project", slug: "destination", type: "project", description: "description", body: "body" },
  }
}

describe("curation suggestion source previews", () => {
  test("includes every source beyond the persisted preview in suggestion identity", () => {
    // Given equivalent 201-source operations that differ only in the final source hash
    const sources = Array.from({ length: 201 }, (_, index) => source(`topic-${String(index).padStart(3, "0")}`, index.toString(16).padStart(64, "0")))
    const changed = [...sources.slice(0, -1), source("topic-200", "f".repeat(64))]

    // When their fingerprints are calculated
    const fingerprints = [suggestionFingerprint(rewrite("first", sources)), suggestionFingerprint(rewrite("second", changed))]

    // Then a source outside the two-item preview still changes identity
    expect(fingerprints[0]).not.toBe(fingerprints[1])
  })

  test("persists a deterministic two-source preview for a proposal-valid 201-source operation", async () => {
    // Given a parsed report-only operation with 201 sources in reverse order
    const sources = Array.from({ length: 201 }, (_, index) => ({
      scope: index % 2 === 0 ? "global" : "project",
      slug: `topic-${String(index).padStart(3, "0")}`,
      sha256: index.toString(16).padStart(64, "0"),
    })).reverse()
    const operation = parseProposal(JSON.stringify({
      version: 1,
      snapshotSha256: HASH_A,
      operations: [{
        id: "many-sources",
        kind: "REWRITE",
        confidence: "high",
        reasonCode: "description-shape",
        sources,
        replacement: { scope: "project", slug: "destination", type: "project", description: "description", body: "body" },
      }],
      findings: [],
      summary: { reviewed: 201, highConfidence: 201, ambiguous: 0 },
    })).operations[0]
    if (operation === undefined) throw new TypeError("proposal fixture omitted its operation")
    const repository = createCurationSuggestionRepository(dir, "project-abc")

    // When the operation is recorded
    await repository.add({ runId: "run", operation, at: 1 })

    // Then only the first two sorted scoped sources persist with the exact total
    const raw = await readFile(repository.paths.inbox, "utf8")
    expect(await repository.list()).toMatchObject([{
      sourcePreview: [{ scope: "global", slug: "topic-000" }, { scope: "global", slug: "topic-002" }],
      sourceCount: 201,
    }])
    expect(raw).not.toContain("sha256")
    expect(raw).not.toContain("topic-004")
  })
})

describe("curation suggestion batching", () => {
  test("submits all actionable operations in one repository batch", async () => {
    // Given a repository spy and a proposal containing two actionable operations plus KEEP
    const batches: AddCurationSuggestion[][] = []
    const repository = {
      paths: { root: "root", inbox: "inbox", lock: "lock" },
      list: async () => [],
      add: async () => { throw new TypeError("single add must not be used") },
      addMany: async (inputs: readonly AddCurationSuggestion[]) => {
        batches.push([...inputs])
        return []
      },
      claim: async () => [],
    }
    const operations: readonly ProposalOperation[] = [
      rewrite("first", [source("first")]),
      { ...rewrite("keep", [source("keep")]), kind: "KEEP" },
      rewrite("second", [source("second")]),
    ]

    // When recording runs once
    const recorded = await recordCurationSuggestions(repository, { runId: "run", operations, at: 10 })

    // Then one batch contains only the actionable inputs in proposal order
    expect(recorded).toBe(2)
    expect(batches).toHaveLength(1)
    expect(batches[0]?.map((input) => input.operation.id)).toEqual(["first", "second"])
  })

  test("preserves first creation time while the latest duplicate locator wins within a batch", async () => {
    // Given one existing suggestion and a batch containing two newer duplicates plus one independent entry
    const repository = createCurationSuggestionRepository(dir, "project-abc")
    const original = rewrite("original", [source("same")])
    await repository.add({ runId: "old-run", operation: original, at: 10 })

    // When the batch refreshes the duplicate twice and adds another suggestion
    await repository.addMany([
      { runId: "middle-run", operation: { ...original, id: "middle" }, at: 20 },
      { runId: "latest-run", operation: { ...original, id: "latest" }, at: 30 },
      { runId: "other-run", operation: rewrite("other", [source("other")]), at: 25 },
    ])

    // Then the original timestamp and latest locator survive in deterministic creation order
    expect(await repository.list()).toMatchObject([
      { runId: "latest-run", operationId: "latest", createdAt: 10, updatedAt: 30 },
      { runId: "other-run", operationId: "other", createdAt: 25, updatedAt: 25 },
    ])
  })

  test("evicts a batch deterministically to the newest 200 entries", async () => {
    // Given 201 unique batch inputs in creation order
    const repository = createCurationSuggestionRepository(dir, "project-abc")
    const inputs = Array.from({ length: 201 }, (_, index) => ({
      runId: `run-${index}`,
      operation: rewrite(`operation-${index}`, [source(`source-${index}`, index.toString(16).padStart(64, "0"))]),
      at: index,
    }))

    // When the full batch is persisted
    await repository.addMany(inputs)

    // Then only the deterministic oldest entry is evicted
    const entries = await repository.list()
    expect(entries).toHaveLength(200)
    expect(entries[0]?.runId).toBe("run-1")
  })
})
