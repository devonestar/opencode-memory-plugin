import { createHash } from "node:crypto"
import { rename } from "node:fs/promises"
import { join } from "node:path"
import { tool } from "@opencode-ai/plugin"
import { type ApplyPlan, type PlanTopic, topicPath } from "./apply-plan"
import { readManifest, writeJournal, writeManifest, type JournalEntry, type RunManifest } from "./artifacts"
import type { CurationConfig } from "./curation-config"
import { RUN_ID_RE } from "./curation-state"
import { INDEX_FILENAME } from "./config"
import { withLock } from "./fsutil"
import { isValidSlug, parseMemory } from "./frontmatter"
import { ensurePrivateDir, ensurePrivateRoot, readPrivate, readPrivateBytes, verifyRegularPrivateFile, writePrivate, writePrivateExclusive } from "./private-fs"
import { captureSnapshot, type CurationStores, type MemorySnapshot, type SnapshotScope } from "./snapshot"

export type ApplyCheckpoint = {
  readonly phase: "before-original-move" | "first-original-moved" | "all-originals-moved" | "indexes-written" | "manifest-written"
  readonly scope?: SnapshotScope
  readonly slug?: string
}

export class SimulatedCrashError extends Error {
  readonly name = "SimulatedCrashError"
  constructor(readonly checkpoint: string) { super(`simulated crash after ${checkpoint}`) }
}

export class RecoveryBlockedError extends Error {
  readonly name = "RecoveryBlockedError"
  constructor(readonly detail: string) { super(`curation recovery blocked: ${detail}`) }
}

export type TransactionInput = {
  readonly runId: string
  readonly runDir: string
  readonly stores: CurationStores
  readonly snapshot: MemorySnapshot
  readonly plan: ApplyPlan
  readonly config: CurationConfig
  readonly clock: () => number
  readonly fault?: (checkpoint: ApplyCheckpoint) => void | Promise<void>
}

type PersistedPlan = ApplyPlan & { readonly version: 1; readonly runId: string; readonly preSnapshotSha256: string }
type MovedTopic = { readonly scope: SnapshotScope; readonly slug: string; readonly sha256: string }

const z = tool.schema
const SHA256_RE = /^[a-f0-9]{64}$/
const topicSchema = z.object({
  scope: z.enum(["global", "project"]),
  slug: z.string().refine(isValidSlug, "unsafe slug"),
  sha256: z.string().regex(SHA256_RE),
  type: z.enum(["user", "feedback", "project", "reference"]),
  description: z.string(),
  body: z.string(),
}).strict()
const planSchema = z.object({
  version: z.literal(1),
  runId: z.string().regex(RUN_ID_RE),
  preSnapshotSha256: z.string().regex(SHA256_RE),
  expectedPostSnapshotSha256: z.string().regex(SHA256_RE),
  sources: z.array(topicSchema),
  survivors: z.array(topicSchema),
  removals: z.array(topicSchema),
  indexPreimages: z.object({ global: z.string().regex(SHA256_RE), project: z.string().regex(SHA256_RE) }).strict(),
  indexes: z.object({ global: z.string(), project: z.string() }).strict(),
}).strict()

function digest(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
}

function manifest(input: TransactionInput, status: "applying" | "applied", planSha256: string): RunManifest {
  return {
    version: 1,
    runId: input.runId,
    status,
    preSnapshotSha256: input.snapshot.sha256,
    ...(status === "applied" ? { postSnapshotSha256: input.plan.expectedPostSnapshotSha256 } : {}),
    planSha256,
    originals: input.plan.removals.map(({ scope, slug, sha256 }) => ({ scope, slug, sha256 })),
    replacements: [],
    reportPath: join(input.runDir, "report.md"),
  }
}

export async function withStoreLocks<T>(stores: CurationStores, work: () => Promise<T>): Promise<T> {
  await Promise.all([ensurePrivateRoot(stores.global), ensurePrivateRoot(stores.project)])
  const paths = [join(stores.global, `${INDEX_FILENAME}.lock`), join(stores.project, `${INDEX_FILENAME}.lock`)].sort()
  const first = paths[0]
  const second = paths[1]
  if (first === undefined || second === undefined) throw new TypeError("both curation store locks are required")
  return withLock(first, () => withLock(second, work))
}

async function prepare(input: TransactionInput, entries: JournalEntry[]): Promise<string> {
  for (const scope of ["global", "project"] as const) {
    const trashDir = join(input.stores[scope], ".trash", input.runId)
    await ensurePrivateDir(input.stores[scope], trashDir)
    const index = input.snapshot.indexes.find((candidate) => candidate.scope === scope)
    await writePrivate(input.stores[scope], join(trashDir, `${INDEX_FILENAME}.before`), index?.raw ?? "")
  }
  const persisted: PersistedPlan = { version: 1, runId: input.runId, preSnapshotSha256: input.snapshot.sha256, ...input.plan }
  const raw = `${JSON.stringify(persisted, null, 2)}\n`
  if (!(await writePrivateExclusive(input.stores.global, join(input.runDir, "plan.json"), raw))) throw new TypeError("apply plan already exists")
  const planSha256 = digest(raw)
  await writeManifest(input.stores.global, input.runDir, manifest(input, "applying", planSha256))
  entries.push({ phase: "prepared", at: input.clock() })
  await writeJournal(input.stores.global, input.runDir, entries)
  return planSha256
}

async function existsRegular(root: string, path: string): Promise<boolean> {
  try {
    await verifyRegularPrivateFile(root, path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function verifiedText(root: string, path: string, expected: string): Promise<string> {
  const { bytes } = await readPrivateBytes(root, path)
  if (digest(bytes) !== expected) throw new RecoveryBlockedError(`artifact hash mismatch: ${path}`)
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

async function verifyTopic(root: string, path: string, topic: PlanTopic): Promise<string> {
  const raw = await verifiedText(root, path, topic.sha256)
  const parsed = parseMemory(raw)
  if (parsed.frontmatter.name !== topic.slug || parsed.frontmatter.type !== topic.type || parsed.frontmatter.description !== topic.description || parsed.body !== topic.body) {
    throw new RecoveryBlockedError(`topic fields mismatch: ${topic.scope}:${topic.slug}`)
  }
  return raw
}

async function rollbackPreimages(stores: CurationStores, runId: string, plan: PersistedPlan): Promise<void> {
  for (const removal of plan.removals) {
    const live = topicPath(stores, removal.scope, removal.slug)
    if (await existsRegular(stores[removal.scope], live)) continue
    const trash = join(stores[removal.scope], ".trash", runId, `${removal.slug}.md`)
    const raw = await verifyTopic(stores[removal.scope], trash, removal)
    await writePrivate(stores[removal.scope], live, raw)
    await verifyTopic(stores[removal.scope], live, removal)
  }
  for (const scope of ["global", "project"] as const) {
    const before = join(stores[scope], ".trash", runId, `${INDEX_FILENAME}.before`)
    const raw = await verifiedText(stores[scope], before, plan.indexPreimages[scope])
    await writePrivate(stores[scope], join(stores[scope], INDEX_FILENAME), raw)
    await verifiedText(stores[scope], join(stores[scope], INDEX_FILENAME), plan.indexPreimages[scope])
  }
}

export async function executeApplyTransaction(input: TransactionInput): Promise<MemorySnapshot> {
  const entries: JournalEntry[] = []
  const moved: MovedTopic[] = []
  const planSha256 = await prepare(input, entries)
  try {
    for (const source of input.plan.sources) await verifyTopic(input.stores[source.scope], topicPath(input.stores, source.scope, source.slug), source)
    for (const original of input.plan.removals) {
      await input.fault?.({ phase: "before-original-move", scope: original.scope, slug: original.slug })
      const live = topicPath(input.stores, original.scope, original.slug)
      await verifyTopic(input.stores[original.scope], live, original)
      const trash = join(input.stores[original.scope], ".trash", input.runId, `${original.slug}.md`)
      if (await existsRegular(input.stores[original.scope], trash)) throw new TypeError(`trash destination already exists: ${original.scope}:${original.slug}`)
      await rename(live, trash)
      moved.push(original)
      entries.push({ phase: "original-moved", at: input.clock(), detail: `${original.scope}:${original.slug}` })
      await writeJournal(input.stores.global, input.runDir, entries)
      if (moved.length === 1) await input.fault?.({ phase: "first-original-moved", scope: original.scope, slug: original.slug })
    }
    await input.fault?.({ phase: "all-originals-moved" })
    for (const scope of ["global", "project"] as const) await writePrivate(input.stores[scope], join(input.stores[scope], INDEX_FILENAME), input.plan.indexes[scope])
    entries.push({ phase: "indexes-written", at: input.clock() })
    await writeJournal(input.stores.global, input.runDir, entries)
    await input.fault?.({ phase: "indexes-written" })
    const post = await captureSnapshot(input.stores, input.config)
    if (post.sha256 !== input.plan.expectedPostSnapshotSha256) throw new TypeError("post-snapshot does not match immutable apply plan")
    await writeManifest(input.stores.global, input.runDir, manifest(input, "applied", planSha256))
    await input.fault?.({ phase: "manifest-written" })
    return post
  } catch (error) {
    if (error instanceof SimulatedCrashError) throw error
    await rollbackPreimages(input.stores, input.runId, { version: 1, runId: input.runId, preSnapshotSha256: input.snapshot.sha256, ...input.plan })
    entries.push({ phase: "rolled-back", at: input.clock(), detail: error instanceof Error ? error.message : "unknown apply failure" })
    await writeJournal(input.stores.global, input.runDir, entries)
    throw error
  }
}

async function readPlan(runId: string, runDir: string, stores: CurationStores): Promise<{ readonly plan: PersistedPlan; readonly sha256: string }> {
  let raw: string
  let decoded: unknown
  try {
    raw = await readPrivate(stores.global, join(runDir, "plan.json"))
    decoded = JSON.parse(raw)
  } catch (error) {
    throw new RecoveryBlockedError(error instanceof Error ? error.message : "apply plan is unreadable")
  }
  const parsed = planSchema.safeParse(decoded)
  if (!parsed.success || parsed.data.runId !== runId) throw new RecoveryBlockedError("apply plan is malformed or belongs to another run")
  return { plan: parsed.data, sha256: digest(raw) }
}

export async function recoverApplyTransaction(input: { readonly runId: string; readonly runDir: string; readonly stores: CurationStores; readonly config: CurationConfig }): Promise<{ readonly status: "rolled-back" | "committed"; readonly snapshot: MemorySnapshot }> {
  const authority = await readPlan(input.runId, input.runDir, input.stores)
  try {
    const currentManifest = await readManifest(input.stores.global, input.runDir)
    if (currentManifest.planSha256 !== authority.sha256) throw new RecoveryBlockedError("manifest plan digest mismatch")
    return await withStoreLocks(input.stores, async () => {
      const current = await captureSnapshot(input.stores, input.config)
      for (const scope of ["global", "project"] as const) {
        await verifiedText(input.stores[scope], join(input.stores[scope], ".trash", input.runId, `${INDEX_FILENAME}.before`), authority.plan.indexPreimages[scope])
      }
      for (const survivor of authority.plan.survivors) await verifyTopic(input.stores[survivor.scope], topicPath(input.stores, survivor.scope, survivor.slug), survivor)
      if (current.sha256 === authority.plan.expectedPostSnapshotSha256) {
        for (const removal of authority.plan.removals) await verifyTopic(input.stores[removal.scope], join(input.stores[removal.scope], ".trash", input.runId, `${removal.slug}.md`), removal)
        if (currentManifest.status !== "applied") await writeManifest(input.stores.global, input.runDir, { ...currentManifest, status: "applied", postSnapshotSha256: current.sha256 })
        await writeJournal(input.stores.global, input.runDir, [{ phase: "recovered-commit", at: Date.now() }])
        return { status: "committed", snapshot: current }
      }
      for (const removal of authority.plan.removals) {
        const live = topicPath(input.stores, removal.scope, removal.slug)
        const trash = join(input.stores[removal.scope], ".trash", input.runId, `${removal.slug}.md`)
        const liveExists = await existsRegular(input.stores[removal.scope], live)
        const trashExists = await existsRegular(input.stores[removal.scope], trash)
        if (!liveExists && !trashExists) throw new RecoveryBlockedError(`original and trash are both missing for ${removal.scope}:${removal.slug}`)
        if (liveExists) await verifyTopic(input.stores[removal.scope], live, removal)
        if (trashExists) await verifyTopic(input.stores[removal.scope], trash, removal)
      }
      await rollbackPreimages(input.stores, input.runId, authority.plan)
      const restored = await captureSnapshot(input.stores, input.config)
      if (restored.sha256 !== authority.plan.preSnapshotSha256) throw new RecoveryBlockedError("rollback did not restore the pre-snapshot")
      await writeJournal(input.stores.global, input.runDir, [{ phase: "recovered-rollback", at: Date.now() }])
      return { status: "rolled-back", snapshot: restored }
    })
  } catch (error) {
    if (error instanceof RecoveryBlockedError) throw error
    throw new RecoveryBlockedError(error instanceof Error ? error.message : "unknown recovery failure")
  }
}
