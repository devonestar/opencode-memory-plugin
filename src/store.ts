import { access, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { INDEX_FILENAME, INDEX_HARD_CAP_BYTES, INDEX_MAX_BYTES, INDEX_MAX_LINES, INDEX_WARN_RATIO, MEMORY_DIR } from "./config"
import { type MemoryType, isValidSlug, serializeMemory } from "./frontmatter"
import { withLock } from "./fsutil"
import { readRegularFileTail, writePrivate } from "./private-fs"
import { buildPointerLine, validateSaveInput } from "./gate"
import type { InjectableIndex } from "./prompt"

export { SecretDetectedError } from "./gate"

export class PathContainmentError extends Error {
  readonly name = "PathContainmentError"
  constructor(readonly slug: string) {
    super(`slug is not a safe filename: ${slug}`)
  }
}

export type SaveInput = {
  readonly type: MemoryType
  readonly slug: string
  readonly description: string
  readonly body: string
}

export type SaveOutcome = {
  readonly file: string
  readonly created: boolean
  readonly indexBytes: number
  readonly warn: boolean
  readonly over: boolean
}

export type MemoryStore = {
  readonly dir: string
  save(input: SaveInput): Promise<SaveOutcome>
  hasSlug(slug: string): Promise<boolean>
  readIndexForInjection(): Promise<InjectableIndex>
}

export function createStore(dir: string = MEMORY_DIR): MemoryStore {
  return {
    dir,
    save: (input) => save(dir, input),
    hasSlug: (slug) => hasSlug(dir, slug),
    readIndexForInjection: () => readIndexForInjection(dir),
  }
}

async function save(dir: string, input: SaveInput): Promise<SaveOutcome> {
  if (!isValidSlug(input.slug)) throw new PathContainmentError(input.slug)
  validateSaveInput(input)

  const file = join(dir, `${input.slug}.md`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return withLock(join(dir, `${INDEX_FILENAME}.lock`), async () => {
    const created = !(await exists(file))
    const content = serializeMemory({ name: input.slug, description: input.description, type: input.type }, input.body)
    await writePrivate(dir, file, content)
    const indexBytes = await upsertPointer(dir, input.slug, input.description)
    return { file, created, indexBytes, warn: indexBytes >= INDEX_MAX_BYTES * INDEX_WARN_RATIO, over: indexBytes > INDEX_MAX_BYTES }
  })
}

/** Read the index, drop any existing pointer to this slug, append the fresh one. */
async function upsertPointer(dir: string, slug: string, description: string): Promise<number> {
  const indexPath = join(dir, INDEX_FILENAME)
  const marker = `](${slug}.md)`
  const kept = (await readIndexSource(indexPath)).content.split("\n").filter((line) => !line.includes(marker))
  const next = `${[...kept, buildPointerLine(slug, description)].filter((line) => line.trim().length > 0).join("\n")}\n`
  await writePrivate(dir, indexPath, next)
  return Buffer.byteLength(next, "utf8")
}

async function readIndexForInjection(dir: string): Promise<InjectableIndex> {
  const source = await readIndexSource(join(dir, INDEX_FILENAME))
  if (source.content.length === 0) return { content: "", truncated: source.truncated }
  const lines = source.content.split("\n").filter((line) => line.trim().length > 0)
  const lineTruncated = lines.length > INDEX_MAX_LINES
  const newest = lines.slice(-INDEX_MAX_LINES).reverse()
  const selected: string[] = []
  let bytes = 0
  for (const line of newest) {
    const addedBytes = Buffer.byteLength(line, "utf8") + (selected.length > 0 ? 1 : 0)
    if (bytes + addedBytes > INDEX_MAX_BYTES) break
    selected.push(line)
    bytes += addedBytes
  }
  const byteTruncated = selected.length < newest.length
  return { content: selected.join("\n"), truncated: source.truncated || lineTruncated || byteTruncated }
}

async function hasSlug(dir: string, slug: string): Promise<boolean> {
  if (!isValidSlug(slug)) throw new PathContainmentError(slug)
  return exists(join(dir, `${slug}.md`))
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // no-excuse-ok: catch — access throws ENOENT when the file is absent; absence is the answer
    return false
  }
}

type IndexSource = {
  readonly content: string
  readonly truncated: boolean
}

async function readIndexSource(path: string): Promise<IndexSource> {
  try {
    const { bytes, truncated } = await readRegularFileTail(path, INDEX_HARD_CAP_BYTES)
    if (!truncated) return { content: bytes.toString("utf8"), truncated: false }
    const tail = bytes.toString("utf8")
    const firstLineEnd = tail.indexOf("\n")
    return { content: firstLineEnd === -1 ? "" : tail.slice(firstLineEnd + 1), truncated: true }
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return { content: "", truncated: false }
    throw e
  }
}
