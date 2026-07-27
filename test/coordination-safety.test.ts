import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import { createCurationService, type CurationClient, type CurationServiceInput, type CurationSession, type ScheduledTimeout } from "../src/orchestrator"
import { createTestStores, proposal, source, writeTopic, type TestStores } from "./curation-fixture"

let dir: string
let stores: TestStores

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-curation-coordination-"))
  stores = await createTestStores(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

class Client implements CurationClient {
  readonly sessions = new Map<string, CurationSession>()
  readonly prompts: string[] = []
  readonly aborts: string[] = []
  finalText = ""
  finalError: string | undefined
  finalCalls = 0
  abortBarrier: Promise<void> | undefined
  finalBarrier: Promise<void> | undefined

  async getSession(sessionID: string): Promise<CurationSession | undefined> {
    return this.sessions.get(sessionID)
  }

  async createSession(parentID: string, title: string): Promise<CurationSession> {
    const child = { id: "child-1", parentID, title }
    this.sessions.set(child.id, child)
    return child
  }

  async promptAsync(sessionID: string): Promise<void> {
    this.prompts.push(sessionID)
  }

  async finalAssistant(): Promise<{ readonly text?: string; readonly error?: string }> {
    this.finalCalls += 1
    if (this.finalBarrier !== undefined) await this.finalBarrier
    return this.finalError === undefined ? { text: this.finalText } : { error: this.finalError }
  }

  async abort(sessionID: string): Promise<void> {
    this.aborts.push(sessionID)
    if (this.abortBarrier !== undefined) await this.abortBarrier
  }

  async notify(): Promise<void> {}
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

  fire(): void {
    for (const callback of [...this.callbacks]) callback()
  }
}

function service(client: Client, clock: () => number, options: { readonly scheduler?: Scheduler; readonly applyFault?: CurationServiceInput["applyFault"] } = {}) {
  return createCurationService({
    client,
    stores,
    globalDir: stores.global,
    namespace: "coordination",
    directory: dir,
    config: { ...DEFAULT_CURATION_CONFIG, allowProviderEgress: true, changedTopics: 1, notify: false, timeoutSeconds: 10 },
    clock,
    scheduler: options.scheduler ?? new Scheduler(),
    createRunID: () => "run-fixed",
    createOwnerToken: () => "owner-fixed",
    ...(options.applyFault === undefined ? {} : { applyFault: options.applyFault }),
  })
}

async function start(client: Client, curation: ReturnType<typeof service>): Promise<{ readonly childID: string; readonly keepText: string }> {
  client.sessions.set("root", { id: "root", title: "primary" })
  await writeTopic(stores, { scope: "global", slug: "kept" })
  const started = await curation.run("root", false)
  const status = await curation.status()
  const active = status.active
  const snapshot = status.snapshot
  if (!started.accepted || active?.childSessionID === undefined || snapshot === undefined) throw new TypeError("fixture run did not start")
  const keep = { id: "keep", kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [source(snapshot, "global", "kept")] }
  return { childID: active.childSessionID, keepText: JSON.stringify(proposal(snapshot, [keep])) }
}

describe("persisted curation fencing", () => {
  test("a fresh service reloads a future active child and finalizes its persisted snapshot", async () => {
    let now = 1_000
    const client = new Client()
    const first = service(client, () => now)
    const fixture = await start(client, first)
    client.finalText = fixture.keepText

    const restarted = service(client, () => now)
    await restarted.handleEvent({ type: "session.status", properties: { sessionID: fixture.childID, status: { type: "idle" } } })
    await restarted.waitForBackgroundWork()

    expect((await restarted.status()).active).toBeUndefined()
    expect((await restarted.status()).lastResult?.status).toBe("no-op")
  })

  test("startup terminally times out an expired active child without another event", async () => {
    let now = 1_000
    const client = new Client()
    const first = service(client, () => now)
    await start(client, first)
    now = 20_000

    const restarted = service(client, () => now)
    const status = await restarted.status()

    expect(status.active).toBeUndefined()
    expect(status.lastResult?.status).toBe("timeout")
    expect(client.aborts).toEqual(["child-1"])
  })

  test("provider-error duplicate idle claims finalization exactly once", async () => {
    const client = new Client()
    const curation = service(client, () => 1_000)
    const fixture = await start(client, curation)
    client.finalError = "provider failed"
    const barrier = Promise.withResolvers<void>()
    client.finalBarrier = barrier.promise

    await Promise.all([
      curation.handleEvent({ type: "session.status", properties: { sessionID: fixture.childID, status: { type: "idle" } } }),
      curation.handleEvent({ type: "session.status", properties: { sessionID: fixture.childID, status: { type: "idle" } } }),
    ])
    barrier.resolve()
    await curation.waitForBackgroundWork()

    expect(client.finalCalls).toBe(1)
    expect((await curation.status()).lastResult?.status).toBe("failed")
  })

  test("startup terminally fails and clears an active run whose child is missing", async () => {
    const client = new Client()
    const first = service(client, () => 1_000)
    await start(client, first)
    client.sessions.delete("child-1")

    const status = await service(client, () => 1_000).status()

    expect(status.active).toBeUndefined()
    expect(status.lastResult?.status).toBe("failed")
  })

  test("startup terminally fails and clears an active run whose snapshot is missing", async () => {
    const client = new Client()
    const first = service(client, () => 1_000)
    await start(client, first)
    await rm(join(stores.global, ".curation", "projects", "coordination", "runs", "run-fixed", "snapshot.json"))

    const status = await service(client, () => 1_000).status()

    expect(status.active).toBeUndefined()
    expect(status.lastResult?.status).toBe("failed")
  })

  test("abort-generated idle cannot claim finalization before timeout abort returns", async () => {
    const client = new Client()
    const scheduler = new Scheduler()
    const curation = service(client, () => 1_000, { scheduler })
    const fixture = await start(client, curation)
    const abort = Promise.withResolvers<void>()
    client.abortBarrier = abort.promise

    scheduler.fire()
    await curation.handleEvent({ type: "session.status", properties: { sessionID: fixture.childID, status: { type: "idle" } } })
    abort.resolve()
    await curation.waitForBackgroundWork()

    expect(client.finalCalls).toBe(0)
    expect((await curation.status()).lastResult?.status).toBe("timeout")
  })

  test("dispose does not terminate an active run owned by another service instance", async () => {
    const client = new Client()
    const first = service(client, () => 1_000)
    await start(client, first)
    const foreign = service(client, () => 1_000)
    await foreign.status()

    await foreign.dispose()

    expect(client.aborts).toEqual([])
    expect((await first.status()).active?.runId).toBe("run-fixed")
  })

  test("dispose during finalizing never downgrades an applying transaction", async () => {
    const description = "identical durable fact"
    const body = "The same durable fact appears in both coordination scopes."
    await writeTopic(stores, { scope: "global", slug: "alpha", description, body })
    await writeTopic(stores, { scope: "project", slug: "beta", description, body })
    const client = new Client()
    client.sessions.set("root", { id: "root", title: "primary" })
    const applying = Promise.withResolvers<void>()
    const finishApply = Promise.withResolvers<void>()
    const curation = service(client, () => 1_000, {
      applyFault: async (checkpoint) => {
        if (checkpoint.phase !== "indexes-written") return
        applying.resolve()
        await finishApply.promise
      },
    })
    const started = await curation.run("root", false)
    const status = await curation.status()
    const snapshot = status.snapshot
    const childID = status.active?.childSessionID
    if (!started.accepted || snapshot === undefined || childID === undefined) throw new TypeError("fixture run did not start")
    client.finalText = JSON.stringify(proposal(snapshot, [{
      id: "exact",
      kind: "MERGE",
      confidence: "high",
      reasonCode: "duplicate-exact",
      sources: [source(snapshot, "global", "alpha"), source(snapshot, "project", "beta")],
      replacement: { scope: "global", slug: "alpha", type: "project", description, body },
    }]))
    await curation.handleEvent({ type: "session.status", properties: { sessionID: childID, status: { type: "idle" } } })
    await applying.promise

    await curation.dispose()
    finishApply.resolve()
    await curation.waitForBackgroundWork()

    expect(client.aborts).toEqual([])
    expect((await curation.status()).lastResult?.status).toBe("applied")
    expect((JSON.parse(await readFile(join(stores.global, ".curation", "projects", "coordination", "runs", "run-fixed", "manifest.json"), "utf8")) as { readonly status?: unknown }).status).toBe("applied")
  })

  test("a completed run ID and existing run directory cannot be reserved again", async () => {
    const client = new Client()
    const first = service(client, () => 1_000)
    const fixture = await start(client, first)
    client.finalText = fixture.keepText
    await first.handleEvent({ type: "session.status", properties: { sessionID: fixture.childID, status: { type: "idle" } } })
    await first.waitForBackgroundWork()

    const second = service(client, () => 2_000)
    expect((await second.run("root", false)).accepted).toBe(false)
    expect(client.prompts).toHaveLength(1)
  })
})
