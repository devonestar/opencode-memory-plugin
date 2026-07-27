import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import {
  createCurationService,
  type CurationServiceInput,
  type CurationClient,
  type CurationSession,
  type ScheduledTimeout,
} from "../src/orchestrator"
import { createTestStores, writeTopic, type TestStores } from "./curation-fixture"

let dir: string
let stores: TestStores

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-curation-orchestrator-"))
  stores = await createTestStores(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

class FakeClient implements CurationClient {
  readonly sessions = new Map<string, CurationSession>()
  readonly prompts: { readonly sessionID: string; readonly model: string; readonly tools: Readonly<Record<string, boolean>>; readonly text: string }[] = []
  readonly aborts: string[] = []
  readonly notifications: string[] = []
  readonly getStarted = Promise.withResolvers<void>()
  getBarrier: Promise<void> | undefined
  finalText = ""
  promptError: Error | undefined
  notifyError: Error | undefined
  childCounter = 0

  async getSession(sessionID: string): Promise<CurationSession | undefined> {
    this.getStarted.resolve()
    if (this.getBarrier !== undefined) await this.getBarrier
    return this.sessions.get(sessionID)
  }

  async createSession(parentID: string, title: string): Promise<CurationSession> {
    this.childCounter += 1
    const child = { id: `child-${this.childCounter}`, parentID, title }
    this.sessions.set(child.id, child)
    return child
  }

  async promptAsync(sessionID: string, model: string, tools: Readonly<Record<string, boolean>>, text: string): Promise<void> {
    this.prompts.push({ sessionID, model, tools, text })
    if (this.promptError !== undefined) throw this.promptError
  }

  async finalAssistant(): Promise<{ readonly text?: string; readonly error?: string }> {
    return { text: this.finalText }
  }

  async abort(sessionID: string): Promise<void> {
    this.aborts.push(sessionID)
  }

  async notify(message: string): Promise<void> {
    if (this.notifyError !== undefined) throw this.notifyError
    this.notifications.push(message)
  }
}

class FakeScheduler implements ScheduledTimeout {
  readonly callbacks: (() => void)[] = []

  schedule(callback: () => void): () => void {
    this.callbacks.push(callback)
    return () => {
      const index = this.callbacks.indexOf(callback)
      if (index >= 0) this.callbacks.splice(index, 1)
    }
  }
}

function service(client: FakeClient, scheduler = new FakeScheduler(), snapshotFault?: CurationServiceInput["snapshotFault"]) {
  return createCurationService({
    client,
    stores,
    globalDir: stores.global,
    namespace: "test-project",
    directory: dir,
    config: { ...DEFAULT_CURATION_CONFIG, allowProviderEgress: true, changedTopics: 1 },
    clock: () => Date.UTC(2026, 6, 26),
    scheduler,
    createRunID: () => "run-fixed",
    createOwnerToken: () => "owner-fixed",
    ...(snapshotFault === undefined ? {} : { snapshotFault }),
  })
}

function egressBlockedService(client: FakeClient) {
  return createCurationService({
    client,
    stores,
    globalDir: stores.global,
    namespace: "egress-blocked",
    directory: dir,
    config: { ...DEFAULT_CURATION_CONFIG, enabled: true, allowProviderEgress: false, changedTopics: 1 },
    createRunID: () => "run-egress",
    createOwnerToken: () => "owner-egress",
  })
}

describe("asynchronous curation coordination", () => {
  test("provider egress false blocks forced dispatch and explains status", async () => {
    await writeTopic(stores, { scope: "global", slug: "eligible" })
    const client = new FakeClient()
    client.sessions.set("root", { id: "root", title: "primary" })
    const curation = egressBlockedService(client)

    const result = await curation.run("root", false)
    const status = await curation.status()

    expect(result.accepted).toBe(false)
    expect(result.message).toContain("provider egress")
    expect(client.prompts).toEqual([])
    expect(status.enabled).toBe(false)
    expect(status.blockedReason).toBe("provider egress disabled")
  })

  test.each([
    "sk-proj-abcdefghijklmnopqrstuv",
    "postgresql://admin:supersecret@example.com/database",
  ])("rejects a tampered raw index before provider egress: %s", async (secret) => {
    await writeTopic(stores, { scope: "global", slug: "eligible" })
    await writeFile(join(stores.global, "MEMORY.md"), `- [eligible](eligible.md) — eligible description\n${secret}\n`)
    const client = new FakeClient()
    client.sessions.set("root", { id: "root", title: "primary" })
    const curation = service(client)

    const result = await curation.run("root", false)

    expect(result.accepted).toBe(false)
    expect(result.message).toContain("index contains a secret")
    expect(client.prompts).toEqual([])
  })

  test("provider model or auth failure records a failed report without fallback dispatch", async () => {
    await writeTopic(stores, { scope: "global", slug: "eligible" })
    const client = new FakeClient()
    client.sessions.set("root", { id: "root", title: "primary" })
    client.promptError = new TypeError("configured model is unavailable or unauthorized")
    const curation = service(client)

    const result = await curation.run("root", false)

    expect(result.accepted).toBe(false)
    expect(client.prompts).toHaveLength(1)
    expect((await curation.status()).lastResult?.status).toBe("failed")
  })

  test("root idle event returns before session verification or generation completes", async () => {
    // Given an eligible root whose lookup is deliberately blocked
    await writeTopic(stores, { scope: "global", slug: "eligible" })
    const client = new FakeClient()
    client.sessions.set("root", { id: "root", title: "primary" })
    const barrier = Promise.withResolvers<void>()
    client.getBarrier = barrier.promise
    const curation = service(client)

    // When root idle is delivered
    const handled = curation.handleEvent({ type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } })
    await handled
    await client.getStarted.promise

    // Then the event has returned while asynchronous verification is still blocked
    expect(client.prompts).toEqual([])
    barrier.resolve()
    client.getBarrier = undefined
    await curation.waitForBackgroundWork()
    expect(client.prompts).toHaveLength(1)
    expect(client.prompts[0]?.tools).toEqual({ "*": false })
  })

  test("suppresses ordinary child and curator-title recursion and permits one active lease", async () => {
    // Given an eligible store, one child, one curator-titled root, and one ordinary root
    await writeTopic(stores, { scope: "global", slug: "eligible" })
    const client = new FakeClient()
    client.sessions.set("child", { id: "child", parentID: "root", title: "ordinary child" })
    client.sessions.set("curator-root", { id: "curator-root", title: "[memory-curation:old] internal" })
    client.sessions.set("root", { id: "root", title: "primary" })
    const curation = service(client)

    // When all candidates idle and two manual runs race for the root
    await curation.handleEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } })
    await curation.handleEvent({ type: "session.status", properties: { sessionID: "curator-root", status: { type: "idle" } } })
    await curation.waitForBackgroundWork()
    const first = await curation.run("root", true)
    const second = await curation.run("root", true)

    // Then recursion starts nothing and the persisted lease rejects the second run
    expect(first.accepted).toBe(true)
    expect(second.accepted).toBe(false)
    expect(client.prompts).toHaveLength(1)
  })

  test("child idle finalizes strict JSON and records a dry-run report", async () => {
    // Given one active dry run and a valid keep-only result
    await writeTopic(stores, { scope: "global", slug: "kept" })
    const client = new FakeClient()
    client.sessions.set("root", { id: "root", title: "primary" })
    const curation = service(client)
    const started = await curation.run("root", true)
    const status = await curation.status()
    const active = status.active
    if (!started.accepted || active === undefined) throw new TypeError("fixture run did not start")
    if (active.childSessionID === undefined) throw new TypeError("fixture curator child missing")
    const topic = status.snapshot?.topics[0]
    if (topic === undefined) throw new TypeError("fixture snapshot topic missing")
    client.finalText = JSON.stringify({
      version: 1,
      snapshotSha256: status.snapshot?.sha256,
      operations: [{ id: "keep", kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [{ scope: topic.scope, slug: topic.slug, sha256: topic.sha256 }] }],
      findings: [],
      summary: { reviewed: 1, highConfidence: 1, ambiguous: 0 },
    })

    // When the exact curator child becomes idle
    await curation.handleEvent({ type: "session.status", properties: { sessionID: active.childSessionID, status: { type: "idle" } } })
    await curation.waitForBackgroundWork()

    // Then the lease closes as a successful dry run with report paths
    const completed = await curation.status()
    expect(completed.active).toBeUndefined()
    expect(completed.lastResult?.status).toBe("dry-run")
    expect(completed.lastResult?.reportPath).toContain("report.md")
  })

  test("headless notification failure cannot downgrade a completed dry run", async () => {
    await writeTopic(stores, { scope: "global", slug: "kept" })
    const client = new FakeClient()
    client.sessions.set("root", { id: "root", title: "primary" })
    client.notifyError = new TypeError("headless TUI unavailable")
    const curation = service(client)
    const started = await curation.run("root", true)
    const status = await curation.status()
    const active = status.active
    const topic = status.snapshot?.topics[0]
    if (!started.accepted || active?.childSessionID === undefined || topic === undefined || status.snapshot === undefined) throw new TypeError("fixture run did not start")
    client.finalText = JSON.stringify({
      version: 1,
      snapshotSha256: status.snapshot.sha256,
      operations: [{ id: "keep", kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [{ scope: topic.scope, slug: topic.slug, sha256: topic.sha256 }] }],
      findings: [],
      summary: { reviewed: 1, highConfidence: 1, ambiguous: 0 },
    })

    await curation.handleEvent({ type: "session.status", properties: { sessionID: active.childSessionID, status: { type: "idle" } } })
    await curation.waitForBackgroundWork()

    expect((await curation.status()).lastResult?.status).toBe("dry-run")
  })

  test("timeout and repeated dispose abort an active curator at most once", async () => {
    // Given an active child and an injected scheduler
    await writeTopic(stores, { scope: "global", slug: "eligible" })
    const client = new FakeClient()
    client.sessions.set("root", { id: "root", title: "primary" })
    const scheduler = new FakeScheduler()
    const curation = service(client, scheduler)
    const started = await curation.run("root", true)
    if (!started.accepted) throw new TypeError("fixture run did not start")

    // When timeout fires and dispose is called twice
    scheduler.callbacks[0]?.()
    await curation.waitForBackgroundWork()
    await curation.dispose()
    await curation.dispose()

    // Then the active child receives exactly one abort request
    expect(client.aborts).toEqual(["child-1"])
    expect((await curation.status()).lastResult?.status).toBe("timeout")
  })

  test("pause and resume are verified-primary controls that gate forced runs", async () => {
    // Given one primary session, one child session, and an eligible store
    await writeTopic(stores, { scope: "global", slug: "eligible" })
    const client = new FakeClient()
    client.sessions.set("root", { id: "root", title: "primary" })
    client.sessions.set("child", { id: "child", parentID: "root", title: "child" })
    const curation = service(client)

    // When child control is rejected and primary control pauses then resumes
    const childPause = await curation.control("child", "pause")
    const paused = await curation.control("root", "pause")
    const blocked = await curation.run("root", true)
    const resumed = await curation.control("root", "resume")

    // Then only the verified primary changes the global pause gate
    expect(childPause.accepted).toBe(false)
    expect(paused.accepted).toBe(true)
    expect(blocked.accepted).toBe(false)
    expect(resumed.accepted).toBe(true)
    expect((await curation.status()).paused).toBe(false)
  })
})
