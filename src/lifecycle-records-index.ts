import { createHash } from "node:crypto"
import { basename, join } from "node:path"
import { INDEX_FILENAME } from "./config"
import { isValidSlug, parseMemory, type MemoryType } from "./frontmatter"
import { buildPointerLine } from "./gate"
import { stageAndPublishBundle } from "./lifecycle-bundle"
import type { LifecycleFault } from "./lifecycle-checkpoints"
import {
  type EntryId,
  type LifecycleReceipt,
  type LifecycleRecord,
  type LifecycleSource,
  parseEntryId,
  parseLifecycleReceipt,
  parseLifecycleRecord,
} from "./lifecycle-schema"
import { replacePrivateBytesAtomic } from "./private-file-move"
import { LIFECYCLE_DIRECTORY_LIMIT, LIFECYCLE_JSON_MAX_BYTES, LIFECYCLE_TOPIC_MAX_BYTES } from "./lifecycle-limits"
import { listPrivateDirectory, readPrivateBytesBounded } from "./private-contained"

export class LifecycleIntegrityError extends Error {
  readonly name = "LifecycleIntegrityError"
  constructor(readonly detail: string) { super(`lifecycle integrity failure: ${detail}`) }
}

export type EntryArtifacts = {
  readonly record: LifecycleRecord
  readonly topic: Buffer
  readonly origin: Extract<LifecycleReceipt, { readonly operation: "archive" | "delete" }>
  readonly state: LifecycleReceipt
}

type ArchiveIndexRow = {
  readonly entryId: EntryId
  readonly scope: LifecycleRecord["scope"]
  readonly slug: string
  readonly type: MemoryType
  readonly description: string
  readonly createdAt: string
}

const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
export const entryRoot = (storeRoot: string, source: LifecycleSource, entryId: EntryId): string => join(storeRoot, source === "archive" ? ".archive" : ".user-trash", "entries", entryId)
export const entryStagingRoot = (storeRoot: string, entryId: EntryId): string => join(storeRoot, ".memory-lifecycle", "staging", `entry-${entryId}`)

export async function materializeEntryBundle(input: {
  readonly storeRoot: string
  readonly record: LifecycleRecord
  readonly topic: Uint8Array
  readonly origin: Extract<LifecycleReceipt, { readonly operation: "archive" | "delete" }>
  readonly fault?: LifecycleFault
}): Promise<void> {
  await stageAndPublishBundle({
    storeRoot: input.storeRoot,
    stagingRoot: entryStagingRoot(input.storeRoot, input.record.entryId),
    destinationRoot: entryRoot(input.storeRoot, input.record.source, input.record.entryId),
    files: [
      { name: "record.json", bytes: jsonBytes(input.record), checkpoint: "entry-record-staged" },
      { name: "topic.md", bytes: input.topic, checkpoint: "entry-topic-staged" },
      { name: "origin.json", bytes: jsonBytes(input.origin), checkpoint: "entry-origin-staged" },
      { name: "state.json", bytes: jsonBytes(input.origin), checkpoint: "entry-state-staged" },
    ],
    publishedCheckpoint: "entry-published",
    ...(input.fault === undefined ? {} : { fault: input.fault }),
  })
}

async function parsedJson(storeRoot: string, path: string): Promise<unknown> {
  try {
    return JSON.parse((await readPrivateBytesBounded(storeRoot, path, LIFECYCLE_JSON_MAX_BYTES)).bytes.toString("utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) throw new LifecycleIntegrityError("persisted JSON is malformed")
    throw error
  }
}

export async function readEntry(storeRoot: string, source: LifecycleSource, entryId: EntryId): Promise<EntryArtifacts> {
  const root = entryRoot(storeRoot, source, entryId)
  const record = parseLifecycleRecord(await parsedJson(storeRoot, join(root, "record.json")))
  const topic = (await readPrivateBytesBounded(storeRoot, join(root, "topic.md"), LIFECYCLE_TOPIC_MAX_BYTES)).bytes
  const parsedOrigin = parseLifecycleReceipt(await parsedJson(storeRoot, join(root, "origin.json")))
  const state = parseLifecycleReceipt(await parsedJson(storeRoot, join(root, "state.json")))
  if (parsedOrigin.operation === "restore") throw new LifecycleIntegrityError("entry origin cannot be restore")
  const origin = parsedOrigin
  if (record.entryId !== entryId || record.source !== source || origin.entryId !== entryId || state.entryId !== entryId) throw new LifecycleIntegrityError("entry identity mismatch")
  if (origin.source !== source || state.source !== source || origin.operation !== (source === "archive" ? "archive" : "delete")) throw new LifecycleIntegrityError("entry source mismatch")
  if (record.topicSha256 !== sha256(topic) || record.topicBytes !== topic.byteLength) throw new LifecycleIntegrityError("topic hash mismatch")
  const parsed = parseMemory(topic.toString("utf8"))
  if (parsed.frontmatter.name !== record.slug || parsed.frontmatter.type !== record.type || parsed.frontmatter.description !== record.description) throw new LifecycleIntegrityError("topic metadata mismatch")
  return { record, topic, origin, state }
}

export async function writeEntryState(storeRoot: string, record: LifecycleRecord, state: LifecycleReceipt): Promise<void> {
  await replacePrivateBytesAtomic(storeRoot, join(entryRoot(storeRoot, record.source, record.entryId), "state.json"), jsonBytes(state))
}

export async function validateActiveTopics(storeRoot: string): Promise<readonly string[]> {
  const names = await listPrivateDirectory(storeRoot, storeRoot, LIFECYCLE_DIRECTORY_LIMIT)
  const pointers: string[] = []
  for (const name of names) {
    if (!name.endsWith(".md") || name === INDEX_FILENAME) continue
    const bytes = (await readPrivateBytesBounded(storeRoot, join(storeRoot, name), LIFECYCLE_TOPIC_MAX_BYTES)).bytes
    let raw: string
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch (error) {
      if (error instanceof TypeError) throw new LifecycleIntegrityError("active topic is not valid UTF-8")
      throw error
    }
    const parsed = parseMemory(raw)
    const slug = basename(name, ".md")
    if (!isValidSlug(slug) || parsed.frontmatter.name !== slug) throw new LifecycleIntegrityError("active topic identity mismatch")
    pointers.push(buildPointerLine(slug, parsed.frontmatter.description))
  }
  return pointers
}

export async function rebuildActiveIndex(storeRoot: string): Promise<void> {
  const pointers = await validateActiveTopics(storeRoot)
  await replacePrivateBytesAtomic(storeRoot, join(storeRoot, INDEX_FILENAME), Buffer.from(pointers.length === 0 ? "" : `${pointers.join("\n")}\n`))
}

export async function rebuildArchiveIndex(storeRoot: string): Promise<void> {
  const entriesRoot = join(storeRoot, ".archive", "entries")
  let ids: readonly string[]
  try {
    ids = await listPrivateDirectory(storeRoot, entriesRoot, LIFECYCLE_DIRECTORY_LIMIT)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") ids = []
    else throw error
  }
  const rows: ArchiveIndexRow[] = []
  for (const id of ids) {
    try {
      const entry = await readEntry(storeRoot, "archive", parseEntryId(id))
      if (entry.state.state === "archived") {
        const { entryId, scope, slug, type, description, createdAt } = entry.record
        rows.push({ entryId, scope, slug, type, description, createdAt })
      }
    } catch (error) {
      if (error instanceof LifecycleIntegrityError) throw error
      throw new LifecycleIntegrityError("archive entry is invalid")
    }
  }
  await replacePrivateBytesAtomic(storeRoot, join(storeRoot, ".archive", "index.json"), jsonBytes({ version: 1, entries: rows }))
}
