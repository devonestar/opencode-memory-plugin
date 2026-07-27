import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import { createCurationService, type CurationClient, type CurationServiceInput, type CurationSession } from "../src/orchestrator"
import { createTestStores, writeTopic, type TestStores } from "./curation-fixture"

let dir: string
let stores: TestStores

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-curation-orchestrator-race-"))
  stores = await createTestStores(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

class FakeClient implements CurationClient {
  readonly sessions = new Map<string, CurationSession>()
  readonly prompts: string[] = []
  childCounter = 0

  async getSession(sessionID: string): Promise<CurationSession | undefined> {
    return this.sessions.get(sessionID)
  }

  async createSession(parentID: string, title: string): Promise<CurationSession> {
    this.childCounter += 1
    const child = { id: `child-${this.childCounter}`, parentID, title }
    this.sessions.set(child.id, child)
    return child
  }

  async promptAsync(sessionID: string, model: string, tools: Readonly<Record<string, boolean>>, text: string): Promise<void> {
    this.prompts.push(`${sessionID}:${model}:${Object.keys(tools).join("+")}:${text.length}`)
  }

  async finalAssistant(): Promise<{ readonly text?: string; readonly error?: string }> {
    return {}
  }

  async abort(): Promise<void> {}
  async notify(): Promise<void> {}
}

function service(client: FakeClient, snapshotFault?: CurationServiceInput["snapshotFault"]) {
  return createCurationService({
    client,
    stores,
    globalDir: stores.global,
    namespace: "test-project-race",
    directory: dir,
    config: { ...DEFAULT_CURATION_CONFIG, allowProviderEgress: true, changedTopics: 1 },
    createRunID: () => "run-fixed",
    createOwnerToken: () => "owner-fixed",
    ...(snapshotFault === undefined ? {} : { snapshotFault }),
  })
}

describe("snapshot race dispatch safety", () => {
  test("rejects symlink swaps before dispatch and keeps the dispatch count at zero", async () => {
    await writeTopic(stores, { scope: "global", slug: "eligible" })
    await writeFile(join(dir, "index-target.md"), "- [eligible](eligible.md) — eligible description\n")
    await writeFile(join(dir, "topic-target.md"), "---\nname: eligible\ndescription: eligible description\nmetadata:\n  type: project\n---\n\nThis is the durable body for eligible.\n")
    const indexReady = Promise.withResolvers<void>()
    const topicReady = Promise.withResolvers<void>()
    const releaseIndex = Promise.withResolvers<void>()
    const releaseTopic = Promise.withResolvers<void>()
    const client = new FakeClient()
    client.sessions.set("root", { id: "root", title: "primary" })
    const curation = service(client, async (checkpoint) => {
      if (checkpoint.scope !== "global") return
      if (checkpoint.phase === "before-index-open") {
        indexReady.resolve()
        await releaseIndex.promise
        return
      }
      if (checkpoint.phase === "before-topic-open" && checkpoint.slug === "eligible") {
        topicReady.resolve()
        await releaseTopic.promise
      }
    })

    const run = curation.run("root", false)
    await Promise.all([indexReady.promise, topicReady.promise])
    await rm(join(stores.global, "MEMORY.md"))
    await symlink(join(dir, "index-target.md"), join(stores.global, "MEMORY.md"))
    await rm(join(stores.global, "eligible.md"))
    await symlink(join(dir, "topic-target.md"), join(stores.global, "eligible.md"))
    releaseIndex.resolve()
    releaseTopic.resolve()

    const result = await run

    expect(result.accepted).toBe(false)
    expect(client.childCounter).toBe(0)
    expect(client.prompts).toEqual([])
  })
})
