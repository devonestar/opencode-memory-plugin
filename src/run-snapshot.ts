import { join } from "node:path"
import { tool } from "@opencode-ai/plugin"
import { MEMORY_TYPES } from "./frontmatter"
import { readPrivate } from "./private-fs"
import { snapshotSha256, type MemorySnapshot } from "./snapshot"

const z = tool.schema
const topicSchema = z.object({
  scope: z.enum(["global", "project"]),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  type: z.enum(MEMORY_TYPES),
  description: z.string(),
  body: z.string(),
}).strict()
const indexSchema = z.object({ scope: z.enum(["global", "project"]), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), raw: z.string() }).strict()
const snapshotSchema = z.object({
  version: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  totalBytes: z.number().int().nonnegative(),
  oldestTopicMtimeMs: z.number().nullable(),
  topics: z.array(topicSchema),
  indexes: z.array(indexSchema).length(2),
}).strict()

export async function readRunSnapshot(privateRoot: string, runDir: string, expectedSha256: string): Promise<MemorySnapshot> {
  let decoded: unknown
  try {
    decoded = JSON.parse(await readPrivate(privateRoot, join(runDir, "snapshot.json")))
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError("persisted curation snapshot is malformed")
    throw error
  }
  const parsed = snapshotSchema.safeParse(decoded)
  if (!parsed.success) throw new TypeError(`persisted curation snapshot is malformed: ${parsed.error.message}`)
  const snapshot = parsed.data
  if (snapshot.sha256 !== expectedSha256 || snapshotSha256(snapshot.topics, snapshot.indexes) !== expectedSha256) {
    throw new TypeError("persisted curation snapshot digest does not match active state")
  }
  const totalBytes = snapshot.topics.reduce((total, topic) => total + topic.bytes, 0) + snapshot.indexes.reduce((total, index) => total + index.bytes, 0)
  const oldest = snapshot.topics.length === 0 ? null : Math.min(...snapshot.topics.map((topic) => topic.mtimeMs))
  if (snapshot.totalBytes !== totalBytes || snapshot.oldestTopicMtimeMs !== oldest) throw new TypeError("persisted curation snapshot metadata is inconsistent")
  return snapshot
}
