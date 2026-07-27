import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SimulatedCrashError, type ApplyCheckpoint } from "../src/apply"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import { createCurationService, type CurationClient, type CurationSession, type ScheduledTimeout } from "../src/orchestrator"
import { captureSnapshot } from "../src/snapshot"
import { createStore } from "../src/store"
import { createTestStores, proposal, source, testSnapshot, writeTopic, type TestStores } from "./curation-fixture"

let dir: string
let stores: TestStores

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-service-recovery-"))
  stores = await createTestStores(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

class Client implements CurationClient {
  readonly sessions = new Map<string, CurationSession>([["root", { id: "root", title: "primary" }]])
  finalText = ""
  async getSession(sessionID: string): Promise<CurationSession | undefined> { return this.sessions.get(sessionID) }
  async createSession(parentID: string, title: string): Promise<CurationSession> { const child = { id: "child", parentID, title }; this.sessions.set(child.id, child); return child }
  async promptAsync(): Promise<void> {}
  async finalAssistant(): Promise<{ readonly text?: string; readonly error?: string }> { return { text: this.finalText } }
  async abort(): Promise<void> {}
  async notify(): Promise<void> {}
}

class Scheduler implements ScheduledTimeout {
  schedule(): () => void { return () => undefined }
}

function service(client: Client, fault?: (checkpoint: ApplyCheckpoint) => void) {
  return createCurationService({
    client,
    stores,
    globalDir: stores.global,
    namespace: "recovery",
    directory: dir,
    config: { ...DEFAULT_CURATION_CONFIG, allowProviderEgress: true, notify: false },
    scheduler: new Scheduler(),
    clock: () => 1_000,
    createRunID: () => "run-recovery",
    createOwnerToken: () => "owner-recovery",
    ...(fault === undefined ? {} : { applyFault: fault }),
  })
}

async function crashAt(phase: ApplyCheckpoint["phase"]) {
  const description = "identical durable fact"
  const body = "The same durable fact appears in both recovery scopes."
  await writeTopic(stores, { scope: "global", slug: "alpha", description, body })
  await writeTopic(stores, { scope: "project", slug: "beta", description, body })
  const before = await testSnapshot(stores)
  const operation = {
    id: "exact",
    kind: "MERGE",
    confidence: "high",
    reasonCode: "duplicate-exact",
    sources: [source(before, "global", "alpha"), source(before, "project", "beta")],
    replacement: { scope: "global", slug: "alpha", type: "project", description, body },
  }
  const client = new Client()
  client.finalText = JSON.stringify(proposal(before, [operation]))
  const crashing = service(client, (checkpoint) => { if (checkpoint.phase === phase) throw new SimulatedCrashError(phase) })
  const started = await crashing.run("root", false)
  if (!started.accepted) throw new TypeError("fixture run did not start")
  await crashing.handleEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } })
  await crashing.waitForBackgroundWork()
  return { before, client, runDir: join(stores.global, ".curation", "projects", "recovery", "runs", "run-recovery") }
}

describe("service startup recovery", () => {
  test("a fresh service rolls back an interrupted topic mutation to the exact pre-hash", async () => {
    const fixture = await crashAt("first-original-moved")

    const status = await service(fixture.client).status()

    expect(status.active).toBeUndefined()
    expect(status.lastResult?.status).toBe("failed")
    expect((await captureSnapshot(stores, DEFAULT_CURATION_CONFIG)).sha256).toBe(fixture.before.sha256)
  })

  test("a fresh service finalizes stores already equal to the persisted post-snapshot", async () => {
    const fixture = await crashAt("manifest-written")
    const committed = JSON.parse(await readFile(join(fixture.runDir, "manifest.json"), "utf8")) as { readonly status?: unknown }
    expect(committed.status).toBe("applied")

    const status = await service(fixture.client).status()

    expect(status.active).toBeUndefined()
    expect(status.lastResult?.status).toBe("applied")
    expect((await captureSnapshot(stores, DEFAULT_CURATION_CONFIG)).sha256).not.toBe(fixture.before.sha256)
  })

  test.each(["missing", "corrupt"] as const)("an applied manifest remains authoritative when snapshot.json is %s", async (condition) => {
    const fixture = await crashAt("manifest-written")
    const committed = await captureSnapshot(stores, DEFAULT_CURATION_CONFIG)
    const snapshotPath = join(fixture.runDir, "snapshot.json")
    if (condition === "missing") await rm(snapshotPath)
    else await writeFile(snapshotPath, "not json")

    const status = await service(fixture.client).status()

    expect(status.active).toBeUndefined()
    expect(status.lastResult?.status).toBe("applied")
    expect((await captureSnapshot(stores, DEFAULT_CURATION_CONFIG)).sha256).toBe(committed.sha256)
    expect((JSON.parse(await readFile(join(fixture.runDir, "manifest.json"), "utf8")) as { readonly status?: unknown }).status).toBe("applied")
    await expect(access(join(stores.project, "beta.md"))).rejects.toBeDefined()
    await expect(access(join(stores.project, ".trash", "run-recovery", "beta.md"))).resolves.toBeNull()
  })

  test("later memory_save drift cannot roll back an applied manifest during restart", async () => {
    const fixture = await crashAt("manifest-written")
    await createStore(stores.project).save({ type: "project", slug: "later-save", description: "later durable save", body: "This memory was saved after curation committed." })
    const drifted = await captureSnapshot(stores, DEFAULT_CURATION_CONFIG)

    const status = await service(fixture.client).status()

    expect(status.active).toBeUndefined()
    expect(status.lastResult?.status).toBe("applied")
    expect((await captureSnapshot(stores, DEFAULT_CURATION_CONFIG)).sha256).toBe(drifted.sha256)
    expect((JSON.parse(await readFile(join(fixture.runDir, "manifest.json"), "utf8")) as { readonly status?: unknown }).status).toBe("applied")
    await expect(access(join(stores.project, "later-save.md"))).resolves.toBeNull()
    await expect(access(join(stores.project, "beta.md"))).rejects.toBeDefined()
  })

  test("corrupt recovery artifacts block the namespace and reject another run", async () => {
    const fixture = await crashAt("first-original-moved")
    await writeFile(join(fixture.runDir, "plan.json"), "not json")
    const restarted = service(fixture.client)

    const status = await restarted.status()

    expect(status.recoveryBlocked?.runId).toBe("run-recovery")
    expect(status.enabled).toBe(false)
    expect(status.active).toBeUndefined()
    expect((await restarted.run("root", false)).accepted).toBe(false)
  })
})
