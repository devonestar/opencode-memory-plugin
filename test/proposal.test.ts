import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import { AUTOMATIC_REASON_CODES, parseProposal, validateProposal } from "../src/proposal"
import { createTestStores, proposal, source, testSnapshot, writeTopic, type TestStores } from "./curation-fixture"

let dir: string
let stores: TestStores

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-curation-proposal-"))
  stores = await createTestStores(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("curator result parsing", () => {
  test("accepts one strict JSON object and rejects markdown or unknown keys", async () => {
    // Given one snapshot and a structurally valid keep result
    await writeTopic(stores, { scope: "global", slug: "kept" })
    const snapshot = await testSnapshot(stores)
    const operation = { id: "keep-1", kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [source(snapshot, "global", "kept")] }
    const raw = JSON.stringify(proposal(snapshot, [operation]))

    // When strict model output is parsed
    const parsed = parseProposal(raw)

    // Then plain JSON succeeds while wrappers and extra properties fail
    expect(parsed.operations).toHaveLength(1)
    expect(() => parseProposal(`\`\`\`json\n${raw}\n\`\`\``)).toThrow()
    expect(() => parseProposal(JSON.stringify({ ...proposal(snapshot, [operation]), path: "/tmp/model-path" }))).toThrow()
  })

  test.each(["line\noperation", "line\roperation", "nul\0operation", "space operation", "markdown*operation"])(
    "rejects unsafe operation identifiers: %p",
    async (id) => {
      await writeTopic(stores, { scope: "global", slug: "kept" })
      const snapshot = await testSnapshot(stores)
      const operation = { id, kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [source(snapshot, "global", "kept")] }
      expect(() => parseProposal(JSON.stringify(proposal(snapshot, [operation])))).toThrow()
    },
  )

  test("accepts digit-prefixed bounded operation IDs and finding kinds", async () => {
    await writeTopic(stores, { scope: "global", slug: "kept" })
    const snapshot = await testSnapshot(stores)
    const operation = { id: "1-keep", kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [source(snapshot, "global", "kept")] }

    const parsed = parseProposal(JSON.stringify({ ...proposal(snapshot, [operation]), findings: [{ kind: "2-note", slugs: ["kept", "global:kept", "project:other-kept"], summary: "Safe bounded finding." }] }))

    expect(parsed.operations[0]?.id).toBe("1-keep")
    expect(parsed.findings[0]?.kind).toBe("2-note")
    expect(parsed.findings[0]?.slugs).toEqual(["kept", "global:kept", "project:other-kept"])
  })

  test.each(["../kept", "global:kept:extra", "project:line\nbreak", "`code`", "kept\0"]) (
    "rejects unsafe finding references: %p",
    async (slug) => {
      await writeTopic(stores, { scope: "global", slug: "kept" })
      const snapshot = await testSnapshot(stores)
      const operation = { id: "keep", kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [source(snapshot, "global", "kept")] }
      expect(() => parseProposal(JSON.stringify({ ...proposal(snapshot, [operation]), findings: [{ kind: "note", slugs: [slug], summary: "safe summary" }] }))).toThrow()
    },
  )

  test.each(["a".repeat(101), "A-upper", "-leading"])("rejects an out-of-policy operation ID and finding kind: %p", async (value) => {
    await writeTopic(stores, { scope: "global", slug: "kept" })
    const snapshot = await testSnapshot(stores)
    const sourceTopic = source(snapshot, "global", "kept")
    expect(() => parseProposal(JSON.stringify(proposal(snapshot, [{ id: value, kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [sourceTopic] }])))).toThrow()
    expect(() => parseProposal(JSON.stringify({ ...proposal(snapshot, [{ id: "keep", kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [sourceTopic] }]), findings: [{ kind: value, slugs: ["kept"], summary: "Safe summary" }] }))).toThrow()
  })

  test.each(["line\nfinding", "line\rfinding", "nul\0finding", "markdown*finding"])(
    "rejects unsafe finding kinds: %p",
    async (kind) => {
      await writeTopic(stores, { scope: "global", slug: "kept" })
      const snapshot = await testSnapshot(stores)
      const operation = { id: "keep", kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [source(snapshot, "global", "kept")] }
      expect(() => parseProposal(JSON.stringify({ ...proposal(snapshot, [operation]), findings: [{ kind, slugs: ["kept"], summary: "safe summary" }] }))).toThrow()
    },
  )

  test("rejects a snapshot digest mismatch, source hash mismatch, and duplicate operation ids", async () => {
    // Given a valid snapshot with malformed ownership claims
    await writeTopic(stores, { scope: "global", slug: "owned" })
    const snapshot = await testSnapshot(stores)
    const wrongSource = { ...source(snapshot, "global", "owned"), sha256: "f".repeat(64) }
    const operation = { id: "same", kind: "DELETE", confidence: "high", reasonCode: "ephemeral-state", sources: [wrongSource] }
    const parsed = parseProposal(JSON.stringify({ ...proposal(snapshot, [operation, operation]), snapshotSha256: "e".repeat(64) }))

    // When local validation checks model ownership
    const result = validateProposal(parsed, snapshot, DEFAULT_CURATION_CONFIG)

    // Then the entire high-confidence apply is rejected
    expect(result.errors.join(" ")).toContain("snapshot")
    expect(result.errors.join(" ")).toContain("source")
    expect(result.errors.join(" ")).toContain("operation id")
    expect(result.applicable).toHaveLength(0)
  })
})

describe("safe automatic operation policy", () => {
  test("has one closed automatic reason-code allowlist", () => {
    expect(AUTOMATIC_REASON_CODES).toEqual(["duplicate-exact"])
  })

  test.each([
    ["duplicate-near", "high"],
    ["conflict", "high"],
    ["contradiction", "high"],
    ["unknown-reason", "high"],
    ["duplicate-exact", "medium"],
    ["duplicate-exact", "low"],
  ])("keeps %s at %s confidence report-only", async (reasonCode, confidence) => {
    await writeTopic(stores, { scope: "global", slug: "ambiguous" })
    const snapshot = await testSnapshot(stores)
    const operation = { id: "ambiguous", kind: "DELETE", confidence, reasonCode, sources: [source(snapshot, "global", "ambiguous")] }

    const result = validateProposal(parseProposal(JSON.stringify(proposal(snapshot, [operation]))), snapshot, DEFAULT_CURATION_CONFIG)

    expect(result.errors).toEqual([])
    expect(result.applicable).toEqual([])
    expect(result.reportOnly.map((item) => item.id)).toEqual(["ambiguous"])
  })

  test.each([
    ["description-shape", "REWRITE"],
    ["body-shape", "REWRITE"],
    ["scope-obvious", "RESCOPE"],
    ["expired-absolute-date", "DELETE"],
    ["derivable-code-fact", "DELETE"],
    ["derivable-git-fact", "DELETE"],
    ["ephemeral-state", "DELETE"],
  ])("keeps high-confidence semantic %s %s report-only", async (reasonCode, kind) => {
    await writeTopic(stores, { scope: "global", slug: "source-topic" })
    const snapshot = await testSnapshot(stores)
    const base = { id: "semantic", kind, confidence: "high", reasonCode, sources: [source(snapshot, "global", "source-topic")] }
    const replacement = { scope: kind === "RESCOPE" ? "project" : "global", slug: "source-topic", type: "project", description: "rewritten model assertion", body: "This is model-authored replacement content." }
    const operation = kind === "REWRITE" || kind === "RESCOPE" || kind === "MERGE" ? { ...base, replacement } : base
    const parsed = parseProposal(JSON.stringify(proposal(snapshot, [operation])))

    const result = validateProposal(parsed, snapshot, DEFAULT_CURATION_CONFIG)

    expect(result.applicable).toHaveLength(0)
    expect(result.errors).toEqual([])
    expect(result.reportOnly.map((item) => item.id)).toEqual(["semantic"])
  })

  test("auto-applies only an exact duplicate merge whose destination is one unchanged source", async () => {
    const description = "identical durable fact"
    const body = "This exact durable body appears in both memory scopes."
    await writeTopic(stores, { scope: "global", slug: "first", description, body })
    await writeTopic(stores, { scope: "global", slug: "unrelated" })
    await writeTopic(stores, { scope: "project", slug: "second", description, body })
    const snapshot = await testSnapshot(stores)
    const operation = {
      id: "exact",
      kind: "MERGE",
      confidence: "high",
      reasonCode: "duplicate-exact",
      sources: [source(snapshot, "global", "first"), source(snapshot, "project", "second")],
      replacement: { scope: "global", slug: "first", type: "project", description, body },
    }
    const parsed = parseProposal(JSON.stringify(proposal(snapshot, [operation])))

    const result = validateProposal(parsed, snapshot, DEFAULT_CURATION_CONFIG)

    expect(result.errors).toEqual([])
    expect(result.applicable.map((item) => item.id)).toEqual(["exact"])
  })

  test("rejects exact duplicate replacement content changes and destination renames", async () => {
    const description = "identical durable fact"
    const body = "This exact durable body appears in both memory scopes."
    await writeTopic(stores, { scope: "global", slug: "first", description, body })
    await writeTopic(stores, { scope: "project", slug: "second", description, body })
    const snapshot = await testSnapshot(stores)
    const base = {
      kind: "MERGE",
      confidence: "high",
      reasonCode: "duplicate-exact",
      sources: [source(snapshot, "global", "first"), source(snapshot, "project", "second")],
    }
    const changed = { ...base, id: "changed", replacement: { scope: "global", slug: "first", type: "project", description: "model changed this", body } }
    const renamed = { ...base, id: "renamed", replacement: { scope: "global", slug: "third", type: "project", description, body } }

    for (const operation of [changed, renamed]) {
      const result = validateProposal(parseProposal(JSON.stringify(proposal(snapshot, [operation]))), snapshot, DEFAULT_CURATION_CONFIG)
      expect(result.applicable).toEqual([])
      expect(result.errors.join(" ")).toContain("duplicate-exact")
    }
  })

  test("accepts omitted snapshot topics but rejects a source repeated across operations", async () => {
    await writeTopic(stores, { scope: "global", slug: "alpha" })
    await writeTopic(stores, { scope: "project", slug: "beta" })
    const snapshot = await testSnapshot(stores)
    const alpha = source(snapshot, "global", "alpha")
    const keep = { id: "keep", kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [alpha] }

    const omitted = validateProposal(parseProposal(JSON.stringify(proposal(snapshot, [keep]))), snapshot, DEFAULT_CURATION_CONFIG)
    const repeated = validateProposal(parseProposal(JSON.stringify(proposal(snapshot, [keep, { ...keep, id: "again" }]))), snapshot, DEFAULT_CURATION_CONFIG)
    const empty = validateProposal(parseProposal(JSON.stringify(proposal(snapshot, []))), snapshot, DEFAULT_CURATION_CONFIG)

    expect(omitted.errors).toEqual([])
    expect(repeated.errors.join(" ")).toContain("repeated")
    expect(empty.errors).toEqual([])
  })

  test.each(["line one\nline two", "line one\rline two", "line\0nul", "escape ``` fence"]) (
    "rejects an unsafe replacement description: %p",
    async (description) => {
      await writeTopic(stores, { scope: "global", slug: "source-topic" })
      const snapshot = await testSnapshot(stores)
      const operation = {
        id: "unsafe-description",
        kind: "REWRITE",
        confidence: "high",
        reasonCode: "description-shape",
        sources: [source(snapshot, "global", "source-topic")],
        replacement: { scope: "global", slug: "source-topic", type: "project", description, body: "A sufficiently long model-authored body." },
      }
      expect(() => parseProposal(JSON.stringify(proposal(snapshot, [operation])))).toThrow("description")
    },
  )

  test("derives review counts locally instead of trusting model summary values", async () => {
    await writeTopic(stores, { scope: "global", slug: "alpha" })
    const snapshot = await testSnapshot(stores)
    const keep = { id: "keep", kind: "KEEP", confidence: "medium", reasonCode: "uncertain", sources: [source(snapshot, "global", "alpha")] }
    const parsed = parseProposal(JSON.stringify({ ...proposal(snapshot, [keep]), summary: { reviewed: 999, highConfidence: 999, ambiguous: 999 } }))

    const result = validateProposal(parsed, snapshot, DEFAULT_CURATION_CONFIG)

    expect(result.errors).toEqual([])
    expect(result.summary).toEqual({ reviewed: 1, highConfidence: 0, ambiguous: 1 })
  })

  test("rejects unbounded or secret-like finding summaries", async () => {
    await writeTopic(stores, { scope: "global", slug: "alpha" })
    const snapshot = await testSnapshot(stores)
    const keep = { id: "keep", kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [source(snapshot, "global", "alpha")] }
    const base = proposal(snapshot, [keep])

    expect(() => parseProposal(JSON.stringify({ ...base, findings: [{ kind: "note", slugs: ["alpha"], summary: "x".repeat(1001) }] }))).toThrow("summary")
    expect(() => parseProposal(JSON.stringify({ ...base, findings: [{ kind: "note", slugs: ["alpha"], summary: `token=ghp_${"a".repeat(36)}` }] }))).toThrow("secret")
    expect(() => parseProposal(JSON.stringify({ ...base, findings: [{ kind: "note", slugs: ["alpha"], summary: "delete\u007fsection" }] }))).toThrow("control")
  })
})
