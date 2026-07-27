import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyValidatedProposal } from "../src/apply"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import { createCurationService, type CurationClient, type CurationSession } from "../src/orchestrator"
import { parseProposal, validateProposal } from "../src/proposal"
import { createTestStores, proposal, source, testSnapshot, writeTopic, type TestStores } from "./curation-fixture"

let dir: string
let outside: string
let stores: TestStores

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-private-path-"))
  outside = await mkdtemp(join(tmpdir(), "mem-private-outside-"))
  stores = await createTestStores(dir)
})

afterEach(async () => {
  await Promise.all([rm(dir, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
})

async function exactValidation() {
  const description = "identical durable fact"
  const body = "The exact same durable fact appears in both memory scopes."
  await writeTopic(stores, { scope: "global", slug: "alpha", description, body })
  await writeTopic(stores, { scope: "project", slug: "beta", description, body })
  const snapshot = await testSnapshot(stores)
  const operation = {
    id: "exact",
    kind: "MERGE",
    confidence: "high",
    reasonCode: "duplicate-exact",
    sources: [source(snapshot, "global", "alpha"), source(snapshot, "project", "beta")],
    replacement: { scope: "global", slug: "alpha", type: "project", description, body },
  }
  return { snapshot, validation: validateProposal(parseProposal(JSON.stringify(proposal(snapshot, [operation]))), snapshot, DEFAULT_CURATION_CONFIG) }
}

class Client implements CurationClient {
  readonly sessions = new Map<string, CurationSession>([["root", { id: "root", title: "primary" }]])
  async getSession(sessionID: string): Promise<CurationSession | undefined> { return this.sessions.get(sessionID) }
  async createSession(parentID: string, title: string): Promise<CurationSession> { return { id: "child", parentID, title } }
  async promptAsync(): Promise<void> {}
  async finalAssistant(): Promise<{ readonly text?: string; readonly error?: string }> { return {} }
  async abort(): Promise<void> {}
  async notify(): Promise<void> {}
}

function service() {
  return createCurationService({
    client: new Client(),
    stores,
    globalDir: stores.global,
    namespace: "private-project",
    directory: dir,
    config: { ...DEFAULT_CURATION_CONFIG, allowProviderEgress: true, notify: false },
    createRunID: () => "run-fixed",
    createOwnerToken: () => "owner-fixed",
  })
}

describe("private curation paths", () => {
  test("rejects a symlinked trash component without writing outside the store", async () => {
    const input = await exactValidation()
    await symlink(outside, join(stores.global, ".trash"))

    await expect(applyValidatedProposal({ runId: "run-trash", runDir: join(stores.global, ".curation", "runs", "run-trash"), stores, ...input, config: DEFAULT_CURATION_CONFIG })).rejects.toThrow("symlink")

    expect(await readdir(outside)).toEqual([])
  })

  test("rejects a topic swapped to a symlink immediately before mutation", async () => {
    const input = await exactValidation()
    const outsideTopic = join(outside, "outside.md")
    await writeFile(outsideTopic, "outside bytes")

    await expect(applyValidatedProposal({
      runId: "run-swap",
      runDir: join(stores.global, ".curation", "runs", "run-swap"),
      stores,
      ...input,
      config: DEFAULT_CURATION_CONFIG,
      fault: async (checkpoint) => {
        if (checkpoint.phase !== "before-original-move") return
        await rm(join(stores.project, "beta.md"))
        await symlink(outsideTopic, join(stores.project, "beta.md"))
      },
    })).rejects.toThrow("symlink")

    expect(await Bun.file(outsideTopic).text()).toBe("outside bytes")
  })

  test("rejects symlinked curation and project namespace components", async () => {
    await writeTopic(stores, { scope: "global", slug: "eligible" })
    await symlink(outside, join(stores.global, ".curation"))
    await expect(service().run("root", false)).rejects.toThrow("symlink")
    expect(await readdir(outside)).toEqual([])

    await rm(join(stores.global, ".curation"))
    await mkdir(join(stores.global, ".curation", "projects"), { recursive: true })
    await symlink(outside, join(stores.global, ".curation", "projects", "private-project"))
    await expect(service().run("root", false)).rejects.toThrow("symlink")
    expect(await readdir(outside)).toEqual([])
  })

  test("an existing symlink run directory rejects reservation without writing outside", async () => {
    await writeTopic(stores, { scope: "global", slug: "eligible" })
    const runs = join(stores.global, ".curation", "projects", "private-project", "runs")
    await mkdir(runs, { recursive: true })
    await symlink(outside, join(runs, "run-fixed"))

    const result = await service().run("root", false)

    expect(result.accepted).toBe(false)
    expect(await readdir(outside)).toEqual([])
  })
})
