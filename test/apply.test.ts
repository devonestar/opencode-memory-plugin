import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyValidatedProposal } from "../src/apply"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import { withLock } from "../src/fsutil"
import { parseProposal, validateProposal } from "../src/proposal"
import { captureSnapshot } from "../src/snapshot"
import { createStore } from "../src/store"
import { createTestStores, proposal, source, testSnapshot, writeTopic, type TestStores } from "./curation-fixture"

let dir: string
let runDir: string
let stores: TestStores

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-curation-apply-"))
  stores = await createTestStores(dir)
  runDir = join(stores.global, ".curation", "runs", "run-1")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function duplicateValidation() {
  const description = "identical durable fact"
  const body = "The same durable fact appears in both isolated scopes."
  await writeTopic(stores, { scope: "global", slug: "dup-one", description, body })
  await writeTopic(stores, { scope: "project", slug: "dup-two", description, body })
  const snapshot = await testSnapshot(stores)
  const operation = {
    id: "duplicate",
    kind: "MERGE",
    confidence: "high",
    reasonCode: "duplicate-exact",
    sources: [source(snapshot, "global", "dup-one"), source(snapshot, "project", "dup-two")],
    replacement: { scope: "global", slug: "dup-one", type: "project", description, body },
  }
  const keeps = snapshot.topics
    .filter((topic) => topic.slug !== "dup-one" && topic.slug !== "dup-two")
    .map((topic) => ({ id: `keep-${topic.slug}`, kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [source(snapshot, topic.scope, topic.slug)] }))
  return { snapshot, validation: validateProposal(parseProposal(JSON.stringify(proposal(snapshot, [operation, ...keeps]))), snapshot, DEFAULT_CURATION_CONFIG) }
}

describe("safe curation apply", () => {
  test("records a report-only no-op without locking stores or creating restore material", async () => {
    await writeTopic(stores, { scope: "global", slug: "reviewed" })
    const before = await testSnapshot(stores)
    const operation = { id: "semantic", kind: "DELETE", confidence: "high", reasonCode: "ephemeral-state", sources: [source(before, "global", "reviewed")] }
    const raw = { ...proposal(before, [operation]), findings: [{ kind: "conflict", slugs: ["global:reviewed", "project:reviewed"], summary: "Human should verify this ambiguous durable claim." }] }
    const validation = validateProposal(parseProposal(JSON.stringify(raw)), before, DEFAULT_CURATION_CONFIG)

    const result = await applyValidatedProposal({ runId: "run-1", runDir, stores, snapshot: before, validation, config: DEFAULT_CURATION_CONFIG })

    expect(result.status).toBe("no-op")
    expect((await testSnapshot(stores)).sha256).toBe(before.sha256)
    await expect(access(join(stores.global, ".trash", "run-1"))).rejects.toBeDefined()
    const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as { readonly status?: unknown }
    expect(manifest.status).toBe("report-only")
    const report = await readFile(join(runDir, "report.md"), "utf8")
    expect(report).toContain("Human should verify this ambiguous durable claim\\.")
    expect(report).toContain("global:reviewed, project:reviewed")
  })

  test("escapes Markdown-sensitive model findings in reports", async () => {
    await writeTopic(stores, { scope: "global", slug: "reviewed" })
    const snapshot = await testSnapshot(stores)
    const operation = { id: "keep", kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [source(snapshot, "global", "reviewed")] }
    const summary = "[click](https://evil.example) *bold* # heading `code`"
    const validation = validateProposal(parseProposal(JSON.stringify({ ...proposal(snapshot, [operation]), findings: [{ kind: "note", slugs: ["reviewed"], summary }] })), snapshot, DEFAULT_CURATION_CONFIG)

    await applyValidatedProposal({ runId: "run-1", runDir, stores, snapshot, validation, config: DEFAULT_CURATION_CONFIG })

    const report = await readFile(join(runDir, "report.md"), "utf8")
    expect(report).not.toContain(summary)
    expect(report).toContain("\\[click\\]\\(https://evil\\.example\\)")
    expect(report).toContain("\\*bold\\*")
    expect(report).toContain("\\`code\\`")
  })

  test("applies only an exact duplicate merge and rebuilds canonical indexes", async () => {
    await writeTopic(stores, { scope: "global", slug: "zeta", description: "zeta durable fact" })
    const { snapshot, validation } = await duplicateValidation()
    const survivor = await readFile(join(stores.global, "dup-one.md"))

    const result = await applyValidatedProposal({ runId: "run-1", runDir, stores, snapshot, validation, config: DEFAULT_CURATION_CONFIG })

    expect(result.status).toBe("applied")
    expect(await readFile(join(stores.global, "dup-one.md"))).toEqual(survivor)
    await expect(access(join(stores.project, "dup-two.md"))).rejects.toBeDefined()
    expect(await readFile(join(stores.global, "MEMORY.md"), "utf8")).toBe(
      "- [zeta](zeta.md) — zeta durable fact\n- [dup-one](dup-one.md) — identical durable fact\n",
    )
    expect(await readFile(join(stores.project, "MEMORY.md"), "utf8")).toBe("")
    await expect(access(join(runDir, "stage"))).rejects.toBeDefined()
    expect((await stat(stores.global)).mode & 0o777).toBe(0o700)
    expect((await stat(stores.project)).mode & 0o777).toBe(0o700)
    expect((await stat(join(stores.project, ".trash", "run-1"))).mode & 0o777).toBe(0o700)
  })

  test("chooses the global lexicographic survivor locally despite a project model destination", async () => {
    const description = "identical cross-scope fact"
    const body = "All three source memories contain exactly the same durable fact."
    await writeTopic(stores, { scope: "global", slug: "zulu", description, body })
    await writeTopic(stores, { scope: "global", slug: "alpha", description, body })
    await writeTopic(stores, { scope: "project", slug: "beta", description, body })
    const snapshot = await testSnapshot(stores)
    const operation = {
      id: "cross-scope",
      kind: "MERGE",
      confidence: "high",
      reasonCode: "duplicate-exact",
      sources: [source(snapshot, "global", "zulu"), source(snapshot, "project", "beta"), source(snapshot, "global", "alpha")],
      replacement: { scope: "project", slug: "beta", type: "project", description, body },
    }
    const validation = validateProposal(parseProposal(JSON.stringify(proposal(snapshot, [operation]))), snapshot, DEFAULT_CURATION_CONFIG)
    const alpha = await readFile(join(stores.global, "alpha.md"))

    const result = await applyValidatedProposal({ runId: "run-1", runDir, stores, snapshot, validation, config: DEFAULT_CURATION_CONFIG })

    expect(result.status).toBe("applied")
    expect(await readFile(join(stores.global, "alpha.md"))).toEqual(alpha)
    await expect(access(join(stores.global, "zulu.md"))).rejects.toBeDefined()
    await expect(access(join(stores.project, "beta.md"))).rejects.toBeDefined()
    expect(await readFile(join(runDir, "report.md"), "utf8")).toContain("destination=global:alpha")
  })

  test("retains exact manual recovery bytes in trash without an automatic restore path", async () => {
    const { snapshot, validation } = await duplicateValidation()
    const removed = await readFile(join(stores.project, "dup-two.md"))
    const beforeIndex = await readFile(join(stores.project, "MEMORY.md"))

    await applyValidatedProposal({ runId: "run-1", runDir, stores, snapshot, validation, config: DEFAULT_CURATION_CONFIG })

    expect(await readFile(join(stores.project, ".trash", "run-1", "dup-two.md"))).toEqual(removed)
    expect(await readFile(join(stores.project, ".trash", "run-1", "MEMORY.md.before"))).toEqual(beforeIndex)
    const report = await readFile(join(runDir, "report.md"), "utf8")
    expect(report).toContain("Manual recovery")
  })

  test("preserves unrelated pointer recency and appends missing pointers by slug", async () => {
    await writeTopic(stores, { scope: "global", slug: "older" })
    await writeTopic(stores, { scope: "global", slug: "newest" })
    const { snapshot, validation } = await duplicateValidation()
    await writeFile(join(stores.global, "MEMORY.md"), [
      "malformed line",
      "- [newest](newest.md) — newest description",
      "- [missing](missing.md) — dangling",
      "- [newest](newest.md) — newest description",
      "- [dup-one](dup-one.md) — identical durable fact",
      "",
    ].join("\n"))
    const current = await testSnapshot(stores)
    const updated = validateProposal(parseProposal(JSON.stringify({ ...validation.proposal, snapshotSha256: current.sha256, operations: validation.proposal.operations.map((operation) => ({ ...operation, sources: operation.sources.map((item) => source(current, item.scope, item.slug)) })) })), current, DEFAULT_CURATION_CONFIG)

    await applyValidatedProposal({ runId: "run-1", runDir, stores, snapshot: current, validation: updated, config: DEFAULT_CURATION_CONFIG })

    expect(await readFile(join(stores.global, "MEMORY.md"), "utf8")).toBe([
      "- [newest](newest.md) — newest description",
      "- [dup-one](dup-one.md) — identical durable fact",
      "- [older](older.md) — older description",
      "",
    ].join("\n"))
  })

  test("post-commit report failure leaves the applied manifest authoritative", async () => {
    const { snapshot, validation } = await duplicateValidation()

    const result = await applyValidatedProposal({
      runId: "run-1",
      runDir,
      stores,
      snapshot,
      validation,
      config: DEFAULT_CURATION_CONFIG,
      fault: async (checkpoint) => {
        if (checkpoint.phase !== "manifest-written") return
        await rm(join(runDir, "report.md"), { force: true })
        await mkdir(join(runDir, "report.md"))
      },
    })

    expect(result.status).toBe("applied")
    const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as { readonly status?: unknown; readonly planSha256?: unknown }
    expect(manifest.status).toBe("applied")
    expect(manifest.planSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test("rejects a stale exact-duplicate snapshot without mutating originals", async () => {
    const { snapshot: before, validation } = await duplicateValidation()
    await createStore(stores.global).save({ type: "project", slug: "concurrent", description: "concurrent save", body: "A concurrent save must make the curation snapshot stale." })

    const result = await applyValidatedProposal({ runId: "run-1", runDir, stores, snapshot: before, validation, config: DEFAULT_CURATION_CONFIG })

    expect(result.status).toBe("stale")
    await expect(access(join(stores.global, "dup-one.md"))).resolves.toBeNull()
    await expect(access(join(stores.project, "dup-two.md"))).resolves.toBeNull()
  })

  test("a concurrent memory_save completing while apply waits makes apply stale", async () => {
    const { snapshot: before, validation } = await duplicateValidation()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const held = withLock(join(stores.global, "MEMORY.md.lock"), async () => { entered.resolve(); await release.promise })
    await entered.promise
    const applying = applyValidatedProposal({ runId: "run-1", runDir, stores, snapshot: before, validation, config: DEFAULT_CURATION_CONFIG })

    await createStore(stores.project).save({ type: "project", slug: "racing", description: "racing save", body: "This concurrent project save wins before curation locks both stores." })
    release.resolve()
    await held
    const result = await applying

    expect(result.status).toBe("stale")
    await expect(access(join(stores.global, "dup-one.md"))).resolves.toBeNull()
    await expect(access(join(stores.project, "racing.md"))).resolves.toBeNull()
    expect((await captureSnapshot(stores, DEFAULT_CURATION_CONFIG)).topics).toHaveLength(3)
  })
})
