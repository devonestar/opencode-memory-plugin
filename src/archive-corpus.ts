import { join } from "node:path"
import { tool } from "@opencode-ai/plugin"
import { parseMemory, type MemoryType } from "./frontmatter"
import type { MemoryScope } from "./gate"
import { lifecycleRecordSchema, lifecycleReceiptSchema, type EntryId } from "./lifecycle-schema"
import { sha256 } from "./lifecycle-records-index"
import { ARCHIVE_AGGREGATE_MAX_BYTES, LIFECYCLE_JSON_MAX_BYTES, LIFECYCLE_TOPIC_MAX_BYTES } from "./lifecycle-limits"
import { readPrivateFilePrefix } from "./private-contained"

export const ARCHIVE_MAX_TOPICS = 200
export const ARCHIVE_MAX_CORPUS_BYTES = ARCHIVE_AGGREGATE_MAX_BYTES
export const ARCHIVE_MAX_TOPIC_BYTES = LIFECYCLE_TOPIC_MAX_BYTES

export type ArchiveDocument = {
  readonly scope: MemoryScope
  readonly slug: string
  readonly type: MemoryType
  readonly description: string
  readonly body: string
  readonly entryId: EntryId
  readonly archivedAt: string
}

export class ArchiveCorpusLimitError extends Error {
  readonly name = "ArchiveCorpusLimitError"
}

export class ArchiveCorpusUnreadableError extends Error {
  readonly name = "ArchiveCorpusUnreadableError"
}

const indexSchema = tool.schema.object({
  version: tool.schema.literal(1),
  entries: tool.schema.array(tool.schema.object({
    entryId: tool.schema.string().uuid().brand("EntryId"),
    scope: tool.schema.enum(["global", "project"]),
    slug: tool.schema.string(),
    type: tool.schema.enum(["user", "feedback", "project", "reference"]),
    description: tool.schema.string(),
    createdAt: tool.schema.string().datetime({ offset: true }),
  }).strict()),
}).strict()

async function bounded(storeRoot: string, path: string, limit: number): Promise<Buffer> {
  const file = await readPrivateFilePrefix(storeRoot, path, limit)
  if (file.bytes.length > limit) throw new ArchiveCorpusLimitError()
  return file.bytes
}

function json(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new ArchiveCorpusUnreadableError()
    throw error
  }
}

export async function loadArchiveCorpus(storeRoot: string, scope: MemoryScope): Promise<readonly ArchiveDocument[]> {
  try {
    let corpusBytes = 0
    const consume = async (path: string, limit: number): Promise<Buffer> => {
      const bytes = await bounded(storeRoot, path, limit)
      corpusBytes += bytes.byteLength
      if (corpusBytes > ARCHIVE_MAX_CORPUS_BYTES) throw new ArchiveCorpusLimitError()
      return bytes
    }
    const index = indexSchema.parse(json(await consume(join(storeRoot, ".archive", "index.json"), LIFECYCLE_JSON_MAX_BYTES)))
    if (index.entries.length > ARCHIVE_MAX_TOPICS) throw new ArchiveCorpusLimitError()
    const documents: ArchiveDocument[] = []
    for (const row of index.entries) {
      if (row.scope !== scope) throw new ArchiveCorpusUnreadableError()
      const entryRoot = join(storeRoot, ".archive", "entries", row.entryId)
      const record = lifecycleRecordSchema.parse(json(await consume(join(entryRoot, "record.json"), LIFECYCLE_JSON_MAX_BYTES)))
      const receipt = lifecycleReceiptSchema.parse(json(await consume(join(entryRoot, "state.json"), LIFECYCLE_JSON_MAX_BYTES)))
      const topic = await consume(join(entryRoot, "topic.md"), ARCHIVE_MAX_TOPIC_BYTES)
      if (record.entryId !== row.entryId || record.scope !== scope || record.source !== "archive" || receipt.entryId !== row.entryId) throw new ArchiveCorpusUnreadableError()
      if (receipt.operation !== "archive") {
        if (receipt.operation === "restore" && receipt.state === "restored") continue
        throw new ArchiveCorpusUnreadableError()
      }
      if (receipt.state !== "archived" || record.slug !== row.slug || record.type !== row.type || record.description !== row.description || record.createdAt !== row.createdAt) throw new ArchiveCorpusUnreadableError()
      if (record.topicBytes !== topic.byteLength || record.topicSha256 !== sha256(topic)) throw new ArchiveCorpusUnreadableError()
      const parsed = parseMemory(new TextDecoder("utf-8", { fatal: true }).decode(topic))
      if (parsed.frontmatter.name !== row.slug || parsed.frontmatter.type !== row.type || parsed.frontmatter.description !== row.description) throw new ArchiveCorpusUnreadableError()
      documents.push({ scope, slug: row.slug, type: row.type, description: row.description, body: parsed.body, entryId: row.entryId, archivedAt: row.createdAt })
    }
    return documents
  } catch (error) {
    if (error instanceof ArchiveCorpusLimitError || error instanceof ArchiveCorpusUnreadableError) throw error
    if (error instanceof Error) throw new ArchiveCorpusUnreadableError()
    throw error
  }
}
