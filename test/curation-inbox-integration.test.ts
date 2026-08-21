import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import { createCurationRepository } from "../src/curation-state"
import { createCurationSuggestionRepository } from "../src/curation-suggestions"
import { createCurationService, type CurationClient, type CurationSession, type ScheduledTimeout } from "../src/orchestrator"
import type { MemorySnapshot } from "../src/snapshot"
import { createTestStores, proposal, source, writeTopic, type TestStores } from "./curation-fixture"

const NAMESPACE = "inbox-project"

let dir: string
let stores: TestStores

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-curation-inbox-integration-"))
  stores = await createTestStores(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

class Client implements CurationClient {
  readonly sessions = new Map<string, CurationSession>([["root", { id: "root", title: "primary" }]])
  readonly notifications: string[] = []
  finalText = ""

  async getSession(sessionID: string): Promise<CurationSession | undefined> { return this.sessions.get(sessionID) }
  async createSession(parentID: string, title: string): Promise<CurationSession> {
    const child = { id: "child", parentID, title }
    this.sessions.set(child.id, child)
    return child
  }
  async promptAsync(): Promise<void> {}
  async finalAssistant(): Promise<{ readonly text?: string; readonly error?: string }> { return { text: this.finalText } }
  async abort(): Promise<void> {}
  async notify(message: string): Promise<void> { this.notifications.push(message) }
}

class Scheduler implements ScheduledTimeout {
  readonly callbacks: (() => void)[] = []
  schedule(callback: () => void): () => void {
    this.callbacks.push(callback)
    return () => {
      const index = this.callbacks.indexOf(callback)
      if (index >= 0) this.callbacks.splice(index, 1)
    }
  }

  fire(): void { this.callbacks[0]?.() }
}

function service(client: Client, scheduler = new Scheduler()) {
  return createCurationService({
    client,
    stores,
    globalDir: stores.global,
    namespace: NAMESPACE,
    directory: dir,
    config: { ...DEFAULT_CURATION_CONFIG, allowProviderEgress: true, changedTopics: 1 },
    clock: () => 1_000,
    scheduler,
    createRunID: () => "run-inbox",
    createOwnerToken: () => "owner-inbox",
  })
}

async function start(client: Client, dryRun: boolean, scheduler?: Scheduler): Promise<{ readonly curation: ReturnType<typeof service>; readonly snapshot: MemorySnapshot; readonly childID: string }> {
  const curation = service(client, scheduler)
  const started = await curation.run("root", dryRun)
  const status = await curation.status()
  const snapshot = status.snapshot
  const childID = status.active?.childSessionID
  if (!started.accepted || snapshot === undefined || childID === undefined) throw new TypeError("fixture run did not start")
  return { curation, snapshot, childID }
}

async function finalize(curation: ReturnType<typeof service>, childID: string): Promise<void> {
  await curation.handleEvent({ type: "session.status", properties: { sessionID: childID, status: { type: "idle" } } })
  await curation.waitForBackgroundWork()
}

describe("curation suggestion integration", () => {
  test("sparse report-only completion records actionable suggestions and filters KEEP", async () => {
    // Given a sparse valid proposal with one advisory operation, one KEEP, and one omitted topic
    await writeTopic(stores, { scope: "global", slug: "reviewed" })
    await writeTopic(stores, { scope: "global", slug: "kept" })
    await writeTopic(stores, { scope: "project", slug: "omitted" })
    const client = new Client()
    const fixture = await start(client, false)
    client.finalText = JSON.stringify(proposal(fixture.snapshot, [
      { id: "remove", kind: "DELETE", confidence: "high", reasonCode: "ephemeral-state", sources: [source(fixture.snapshot, "global", "reviewed")] },
      { id: "keep", kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [source(fixture.snapshot, "global", "kept")] },
    ]))

    // When the curator result finalizes
    await finalize(fixture.curation, fixture.childID)

    // Then only the actionable operation enters the namespace inbox
    const suggestions = await createCurationSuggestionRepository(stores.global, NAMESPACE).list()
    expect((await fixture.curation.status()).lastResult?.status).toBe("report-only")
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({ runId: "run-inbox", operationId: "remove", kind: "DELETE" })
    expect(client.notifications[0]).toContain("1 actionable suggestion recorded")
    expect(client.notifications[0]).toContain("no exact merges applied")
  })

  test("dry-run completion does not record actionable suggestions", async () => {
    // Given a dry run with one valid advisory operation
    await writeTopic(stores, { scope: "global", slug: "reviewed" })
    const client = new Client()
    const fixture = await start(client, true)
    client.finalText = JSON.stringify(proposal(fixture.snapshot, [
      { id: "remove", kind: "DELETE", confidence: "high", reasonCode: "ephemeral-state", sources: [source(fixture.snapshot, "global", "reviewed")] },
    ]))

    // When the dry run finalizes
    await finalize(fixture.curation, fixture.childID)

    // Then its report succeeds without creating an inbox entry
    expect((await fixture.curation.status()).lastResult?.status).toBe("dry-run")
    expect(await createCurationSuggestionRepository(stores.global, NAMESPACE).list()).toEqual([])
    expect(client.notifications[0]).toContain("0 actionable suggestions recorded")
    expect(client.notifications[0]).toContain("no exact merges applied")
  })

  test("malformed suggestion inbox records an error without downgrading completion", async () => {
    // Given a valid advisory result and a malformed namespace inbox
    await writeTopic(stores, { scope: "global", slug: "reviewed" })
    const client = new Client()
    const fixture = await start(client, false)
    client.finalText = JSON.stringify(proposal(fixture.snapshot, [
      { id: "remove", kind: "DELETE", confidence: "high", reasonCode: "ephemeral-state", sources: [source(fixture.snapshot, "global", "reviewed")] },
    ]))
    const suggestions = createCurationSuggestionRepository(stores.global, NAMESPACE)
    await writeFile(suggestions.paths.inbox, "not json", { mode: 0o600 })

    // When finalization attempts to record the suggestion
    await finalize(fixture.curation, fixture.childID)

    // Then curation remains complete and the queue failure is visible in repository state
    const state = await createCurationRepository(stores.global, NAMESPACE).readState()
    expect(state.lastResult?.status).toBe("report-only")
    expect(state.lastError?.message).toContain("curation suggestion recording failed")
    expect(await readFile(suggestions.paths.inbox, "utf8")).toBe("not json")
  })

  test("applied exact merge records advisory suggestions and reports both outcomes", async () => {
    // Given one exact duplicate merge and one independent advisory operation
    const description = "identical durable fact"
    const body = "The same durable fact appears in both scopes."
    await writeTopic(stores, { scope: "global", slug: "alpha", description, body })
    await writeTopic(stores, { scope: "project", slug: "beta", description, body })
    await writeTopic(stores, { scope: "global", slug: "reviewed" })
    const client = new Client()
    const fixture = await start(client, false)
    client.finalText = JSON.stringify(proposal(fixture.snapshot, [
      {
        id: "exact",
        kind: "MERGE",
        confidence: "high",
        reasonCode: "duplicate-exact",
        sources: [source(fixture.snapshot, "global", "alpha"), source(fixture.snapshot, "project", "beta")],
        replacement: { scope: "global", slug: "alpha", type: "project", description, body },
      },
      { id: "remove", kind: "DELETE", confidence: "high", reasonCode: "ephemeral-state", sources: [source(fixture.snapshot, "global", "reviewed")] },
    ]))

    // When the mixed result finalizes
    await finalize(fixture.curation, fixture.childID)

    // Then the exact merge applies while the advisory operation is recorded separately
    expect((await fixture.curation.status()).lastResult?.status).toBe("applied")
    expect(await createCurationSuggestionRepository(stores.global, NAMESPACE).list()).toHaveLength(1)
    expect(client.notifications[0]).toContain("1 actionable suggestion recorded")
    expect(client.notifications[0]).toContain("1 exact merge applied")
  })

  test("reads historical persisted no-op results", async () => {
    // Given state persisted by the historical no-op status
    const repository = createCurationRepository(stores.global, NAMESPACE)
    await mkdir(repository.paths.root, { recursive: true, mode: 0o700 })
    await writeFile(repository.paths.state, `${JSON.stringify({ version: 1, lastResult: { runId: "old-run", status: "no-op", at: 1 } })}\n`, { mode: 0o600 })

    // When a new service reads status
    const status = await service(new Client()).status()

    // Then the legacy result remains readable without migration
    expect(status.lastResult?.status).toBe("no-op")
  })

  test("validation failure does not record report-only operations", async () => {
    // Given a proposal whose advisory operation belongs to the wrong snapshot
    await writeTopic(stores, { scope: "global", slug: "reviewed" })
    const client = new Client()
    const fixture = await start(client, false)
    client.finalText = JSON.stringify({
      ...proposal(fixture.snapshot, [
        { id: "remove", kind: "DELETE", confidence: "high", reasonCode: "ephemeral-state", sources: [source(fixture.snapshot, "global", "reviewed")] },
      ]),
      snapshotSha256: "a".repeat(64),
    })

    // When validation rejects finalization
    await finalize(fixture.curation, fixture.childID)

    // Then no advisory operation reaches the inbox
    expect((await fixture.curation.status()).lastResult?.status).toBe("validation-failed")
    expect(await createCurationSuggestionRepository(stores.global, NAMESPACE).list()).toEqual([])
  })

  test("timeout does not create a suggestion inbox entry", async () => {
    // Given an active non-dry curator run
    await writeTopic(stores, { scope: "global", slug: "reviewed" })
    const client = new Client()
    const scheduler = new Scheduler()
    const fixture = await start(client, false, scheduler)

    // When its timeout fires before a result is retrieved
    scheduler.fire()
    await fixture.curation.waitForBackgroundWork()

    // Then the terminal timeout has no suggestion side effect
    expect((await fixture.curation.status()).lastResult?.status).toBe("timeout")
    expect(await createCurationSuggestionRepository(stores.global, NAMESPACE).list()).toEqual([])
  })

  test("stale exact merge does not create a suggestion inbox entry", async () => {
    // Given a valid exact merge whose memory snapshot changes before apply
    const description = "identical durable fact"
    const body = "The same durable fact appears in both scopes."
    await writeTopic(stores, { scope: "global", slug: "alpha", description, body })
    await writeTopic(stores, { scope: "project", slug: "beta", description, body })
    const client = new Client()
    const fixture = await start(client, false)
    client.finalText = JSON.stringify(proposal(fixture.snapshot, [{
      id: "exact",
      kind: "MERGE",
      confidence: "high",
      reasonCode: "duplicate-exact",
      sources: [source(fixture.snapshot, "global", "alpha"), source(fixture.snapshot, "project", "beta")],
      replacement: { scope: "global", slug: "alpha", type: "project", description, body },
    }]))
    await writeTopic(stores, { scope: "global", slug: "concurrent" })

    // When apply detects the changed snapshot
    await finalize(fixture.curation, fixture.childID)

    // Then stale finalization has no suggestion side effect
    expect((await fixture.curation.status()).lastResult?.status).toBe("stale")
    expect(await createCurationSuggestionRepository(stores.global, NAMESPACE).list()).toEqual([])
  })
})
