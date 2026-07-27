import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import { createCurationRepository } from "../src/curation-state"
import { createCurationService, type CurationClient, type CurationSession, type ScheduledTimeout } from "../src/orchestrator"
import { readRunSnapshot } from "../src/run-snapshot"
import { proposal, source, writeTopic, type TestStores } from "./curation-fixture"

class Client implements CurationClient {
  readonly sessions = new Map<string, CurationSession>()
  finalText = ""
  async getSession(sessionID: string): Promise<CurationSession | undefined> { return this.sessions.get(sessionID) }
  async createSession(parentID: string, title: string): Promise<CurationSession> { const child = { id: "child-restart", parentID, title }; this.sessions.set(child.id, child); return child }
  async promptAsync(): Promise<void> {}
  async finalAssistant(): Promise<{ readonly text?: string; readonly error?: string }> { return { text: this.finalText } }
  async abort(): Promise<void> {}
  async notify(): Promise<void> {}
}

class Scheduler implements ScheduledTimeout {
  schedule(): () => void { return () => undefined }
}

const rootArgument = process.argv[3]
const phase = process.argv[2]
if (rootArgument === undefined || phase === undefined) throw new TypeError("probe requires phase and root")
const root = rootArgument
const stores = { global: join(root, "global"), project: join(root, "project") } satisfies TestStores
await Promise.all([mkdir(stores.global, { recursive: true, mode: 0o700 }), mkdir(stores.project, { recursive: true, mode: 0o700 })])

function service(client: Client) {
  return createCurationService({
    client,
    stores,
    globalDir: stores.global,
    namespace: "restart",
    directory: root,
    config: { ...DEFAULT_CURATION_CONFIG, allowProviderEgress: true, notify: false },
    scheduler: new Scheduler(),
    clock: () => 1_000,
    createRunID: () => "run-restart",
    createOwnerToken: () => "owner-restart",
  })
}

if (phase === "dispatch") {
  await writeTopic(stores, { scope: "global", slug: "kept" })
  const client = new Client()
  client.sessions.set("root", { id: "root", title: "primary" })
  const result = await service(client).run("root", false)
  process.stdout.write(`${JSON.stringify(result)}\n`)
} else if (phase === "recover") {
  const repository = createCurationRepository(stores.global, "restart")
  const active = (await repository.readState()).active
  if (active?.childSessionID === undefined) throw new TypeError("active child is missing")
  const runDir = join(repository.paths.runs, active.runId)
  const snapshot = await readRunSnapshot(stores.global, runDir, active.snapshotSha256)
  const keep = { id: "keep", kind: "KEEP", confidence: "high", reasonCode: "still-valid", sources: [source(snapshot, "global", "kept")] }
  const client = new Client()
  client.sessions.set("root", { id: "root", title: "primary" })
  client.sessions.set(active.childSessionID, { id: active.childSessionID, parentID: "root", title: `[memory-curation:${active.runId}] automatic memory audit` })
  client.finalText = JSON.stringify(proposal(snapshot, [keep]))
  const curation = service(client)
  await curation.handleEvent({ type: "session.status", properties: { sessionID: active.childSessionID, status: { type: "idle" } } })
  await curation.waitForBackgroundWork()
  process.stdout.write(`${JSON.stringify(await curation.status())}\n`)
} else {
  throw new TypeError("probe phase must be dispatch or recover")
}
