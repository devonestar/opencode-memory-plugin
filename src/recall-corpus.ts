import { join } from "node:path"
import { MemoryParseError, isValidSlug, parseMemory, type MemoryType } from "./frontmatter"
import { buildPointerLine, SaveGateError, validateSaveInput, type MemoryScope } from "./gate"
import { PrivatePathError, readRegularFilePrefix } from "./private-fs"
import type { InjectableIndex } from "./prompt"
import type { MemoryStore } from "./store"

export const RECALL_MAX_TOPIC_BYTES = 32 * 1024
export const RECALL_MAX_TOPICS = 200
export const RECALL_MAX_CORPUS_BYTES = 512 * 1024

export type RecallSource = {
  readonly scope: MemoryScope
  readonly store: MemoryStore
}

export type RecallDocument = {
  readonly scope: MemoryScope
  readonly slug: string
  readonly type: MemoryType
  readonly description: string
  readonly body: string
}

export type RecallCorpusIncompleteReason = "truncated-index" | "topic-limit" | "byte-limit"
export type RecallCorpusReadStage = "index" | "topic"

export class RecallCorpusIncompleteError extends Error {
  readonly name = "RecallCorpusIncompleteError"
  constructor(readonly reason: RecallCorpusIncompleteReason) {
    super(`recall corpus is incomplete: ${reason}`)
  }
}

export class RecallCorpusUnreadableError extends Error {
  readonly name = "RecallCorpusUnreadableError"
  constructor(readonly scope: MemoryScope, readonly stage: RecallCorpusReadStage) {
    super(`recall corpus is unreadable: ${scope} ${stage}`)
  }
}

type SelectedSource = RecallSource & {
  readonly index: InjectableIndex
}

type RecallPointer = RecallSource & {
  readonly slug: string
  readonly description: string
}

type LoadedDocument = {
  readonly bytes: number
  readonly document: RecallDocument
}

const POINTER_LINE_RE = /^- \[([^\]]+)\]\(([^)]+)\) — (.+)$/
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

export async function loadRecallCorpus(sources: readonly RecallSource[]): Promise<readonly RecallDocument[]> {
  const selected = await Promise.all(sources.map(selectIndex))
  const pointers = collectPointers(selected)
  const documents: RecallDocument[] = []
  let corpusBytes = 0

  for (const pointer of pointers) {
    const loaded = await loadDocument(pointer)
    if (loaded === null) continue
    if (documents.length >= RECALL_MAX_TOPICS) throw new RecallCorpusIncompleteError("topic-limit")
    if (corpusBytes + loaded.bytes > RECALL_MAX_CORPUS_BYTES) throw new RecallCorpusIncompleteError("byte-limit")
    documents.push(Object.freeze(loaded.document))
    corpusBytes += loaded.bytes
  }

  return Object.freeze(documents)
}

async function selectIndex(source: RecallSource): Promise<SelectedSource> {
  let index: InjectableIndex
  try {
    index = await source.store.readIndexForInjection()
  } catch {
    throw new RecallCorpusUnreadableError(source.scope, "index")
  }
  if (index.truncated) throw new RecallCorpusIncompleteError("truncated-index")
  return { ...source, index }
}

function collectPointers(sources: readonly SelectedSource[]): readonly RecallPointer[] {
  const pointers: RecallPointer[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    for (const line of source.index.content.split("\n")) {
      const pointer = parsePointer(source, line)
      if (pointer === null) continue
      const key = `${pointer.scope}\0${pointer.slug}`
      if (seen.has(key)) continue
      seen.add(key)
      pointers.push(pointer)
    }
  }
  return pointers
}

function parsePointer(source: RecallSource, line: string): RecallPointer | null {
  const match = line.match(POINTER_LINE_RE)
  if (match === null) return null
  const slug = match[1]
  const filename = match[2]
  const description = match[3]
  if (slug === undefined || filename === undefined || description === undefined) return null
  if (!isValidSlug(slug) || filename !== `${slug}.md`) return null
  if (buildPointerLine(slug, description) !== line) return null
  return { ...source, slug, description }
}

async function loadDocument(pointer: RecallPointer): Promise<LoadedDocument | null> {
  let bytes: Buffer
  try {
    bytes = (await readRegularFilePrefix(join(pointer.store.dir, `${pointer.slug}.md`), RECALL_MAX_TOPIC_BYTES)).bytes
  } catch (error) {
    if (error instanceof PrivatePathError || hasCode(error, "ENOENT")) return null
    throw new RecallCorpusUnreadableError(pointer.scope, "topic")
  }
  if (bytes.length > RECALL_MAX_TOPIC_BYTES) return null

  let raw: string
  try {
    raw = UTF8_DECODER.decode(bytes)
  } catch (error) {
    if (error instanceof TypeError) return null
    throw new RecallCorpusUnreadableError(pointer.scope, "topic")
  }

  let parsed: ReturnType<typeof parseMemory>
  try {
    parsed = parseMemory(raw)
  } catch (error) {
    if (error instanceof MemoryParseError) return null
    throw new RecallCorpusUnreadableError(pointer.scope, "topic")
  }
  if (parsed.frontmatter.name !== pointer.slug || parsed.frontmatter.description !== pointer.description) return null
  try {
    validateSaveInput({ slug: pointer.slug, description: parsed.frontmatter.description, body: parsed.body })
  } catch (error) {
    if (error instanceof SaveGateError) return null
    throw new RecallCorpusUnreadableError(pointer.scope, "topic")
  }
  return {
    bytes: bytes.length,
    document: {
      scope: pointer.scope,
      slug: pointer.slug,
      type: parsed.frontmatter.type,
      description: parsed.frontmatter.description,
      body: parsed.body,
    },
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
