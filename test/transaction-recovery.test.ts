import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyValidatedProposal, recoverApplyTransaction, SimulatedCrashError, type ApplyCheckpoint } from "../src/apply"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import { parseProposal, validateProposal } from "../src/proposal"
import { captureSnapshot } from "../src/snapshot"
import { createTestStores, proposal, source, testSnapshot, writeTopic, type TestStores } from "./curation-fixture"

let dir: string
let stores: TestStores

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-curation-recovery-"))
  stores = await createTestStores(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function exactDuplicate(runId: string) {
  const description = "identical durable fact"
  const body = "The exact same durable fact appears in both isolated scopes."
  await writeTopic(stores, { scope: "global", slug: "alpha", description, body })
  await writeTopic(stores, { scope: "project", slug: "beta", description, body })
  const snapshot = await testSnapshot(stores)
  const operation = {
    id: "duplicate",
    kind: "MERGE",
    confidence: "high",
    reasonCode: "duplicate-exact",
    sources: [source(snapshot, "global", "alpha"), source(snapshot, "project", "beta")],
    replacement: { scope: "global", slug: "alpha", type: "project", description, body },
  }
  const validation = validateProposal(parseProposal(JSON.stringify(proposal(snapshot, [operation]))), snapshot, DEFAULT_CURATION_CONFIG)
  return { runId, runDir: join(stores.global, ".curation", "runs", runId), snapshot, validation }
}

describe("persisted apply recovery", () => {
  test("a second original move failure preserves both original bytes and exact indexes", async () => {
    const input = await exactDuplicate("run-move-failure")
    const alpha = await readFile(join(stores.global, "alpha.md"))
    const beta = await readFile(join(stores.project, "beta.md"))
    const globalIndex = await readFile(join(stores.global, "MEMORY.md"))
    const projectIndex = await readFile(join(stores.project, "MEMORY.md"))
    const fault = (checkpoint: ApplyCheckpoint): void => {
      if (checkpoint.phase === "before-original-move" && checkpoint.slug === "beta") throw new TypeError("injected second source move failure")
    }

    await expect(applyValidatedProposal({ ...input, stores, config: DEFAULT_CURATION_CONFIG, fault })).rejects.toThrow("second source move")

    expect(await readFile(join(stores.global, "alpha.md"))).toEqual(alpha)
    expect(await readFile(join(stores.project, "beta.md"))).toEqual(beta)
    expect(await readFile(join(stores.global, "MEMORY.md"))).toEqual(globalIndex)
    expect(await readFile(join(stores.project, "MEMORY.md"))).toEqual(projectIndex)
  })

  test.each([
    ["first-original-moved", "rolled-back"],
    ["all-originals-moved", "rolled-back"],
    ["indexes-written", "committed"],
    ["manifest-written", "committed"],
  ] as const)("fresh recovery handles a crash after %s as %s", async (crashPhase, expected) => {
    const input = await exactDuplicate(`run-crash-${crashPhase}`)
    const fault = (checkpoint: ApplyCheckpoint): void => {
      if (checkpoint.phase === crashPhase) throw new SimulatedCrashError(crashPhase)
    }

    await expect(applyValidatedProposal({ ...input, stores, config: DEFAULT_CURATION_CONFIG, fault })).rejects.toBeInstanceOf(SimulatedCrashError)
    const recovered = await recoverApplyTransaction({ runId: input.runId, runDir: input.runDir, stores, config: DEFAULT_CURATION_CONFIG })

    expect(recovered.status).toBe(expected)
    const current = await captureSnapshot(stores, DEFAULT_CURATION_CONFIG)
    if (expected === "rolled-back") expect(current.sha256).toBe(input.snapshot.sha256)
    else expect(current.sha256).not.toBe(input.snapshot.sha256)
  })

  test("rejects a traversal slug in a tampered plan before touching store files", async () => {
    const input = await exactDuplicate("run-tampered-slug")
    const fault = (checkpoint: ApplyCheckpoint): void => {
      if (checkpoint.phase === "first-original-moved") throw new SimulatedCrashError(checkpoint.phase)
    }
    await expect(applyValidatedProposal({ ...input, stores, config: DEFAULT_CURATION_CONFIG, fault })).rejects.toBeInstanceOf(SimulatedCrashError)
    const planPath = join(input.runDir, "plan.json")
    const plan = JSON.parse(await readFile(planPath, "utf8")) as { removals: { slug: string }[] }
    const first = plan.removals[0]
    if (first === undefined) throw new TypeError("fixture removal missing")
    first.slug = "../escape"
    await writeFile(planPath, `${JSON.stringify(plan)}\n`)

    await expect(recoverApplyTransaction({ runId: input.runId, runDir: input.runDir, stores, config: DEFAULT_CURATION_CONFIG })).rejects.toThrow("malformed")

    await expect(access(join(dir, "escape.md"))).rejects.toBeDefined()
  })

  test.each(["trash", "index-preimage"] as const)("blocks recovery when the %s hash mismatches", async (artifact) => {
    const input = await exactDuplicate(`run-tampered-${artifact}`)
    const fault = (checkpoint: ApplyCheckpoint): void => {
      if (checkpoint.phase === "indexes-written") throw new SimulatedCrashError(checkpoint.phase)
    }
    await expect(applyValidatedProposal({ ...input, stores, config: DEFAULT_CURATION_CONFIG, fault })).rejects.toBeInstanceOf(SimulatedCrashError)
    const target = artifact === "trash"
      ? join(stores.project, ".trash", input.runId, "beta.md")
      : join(stores.project, ".trash", input.runId, "MEMORY.md.before")
    await writeFile(target, "tampered")

    await expect(recoverApplyTransaction({ runId: input.runId, runDir: input.runDir, stores, config: DEFAULT_CURATION_CONFIG })).rejects.toThrow("hash mismatch")
  })

  test("cross-checks the immutable plan digest stored in the manifest", async () => {
    const input = await exactDuplicate("run-plan-digest")
    const fault = (checkpoint: ApplyCheckpoint): void => {
      if (checkpoint.phase === "first-original-moved") throw new SimulatedCrashError(checkpoint.phase)
    }
    await expect(applyValidatedProposal({ ...input, stores, config: DEFAULT_CURATION_CONFIG, fault })).rejects.toBeInstanceOf(SimulatedCrashError)
    const planPath = join(input.runDir, "plan.json")
    const plan = JSON.parse(await readFile(planPath, "utf8")) as { indexes: { global: string } }
    plan.indexes.global = `${plan.indexes.global}\n`
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`)

    await expect(recoverApplyTransaction({ runId: input.runId, runDir: input.runDir, stores, config: DEFAULT_CURATION_CONFIG })).rejects.toThrow("plan digest")
  })
})
