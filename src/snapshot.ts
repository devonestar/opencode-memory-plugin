import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { CurationConfig } from "./curation-config"
import { INDEX_FILENAME } from "./config"
import { isValidSlug, parseMemory, type MemoryType } from "./frontmatter"
import { isSafeDescription } from "./gate"
import { scanForSecret } from "./secrets"
import { captureTrustedDirectory, PrivatePathError, readRegularFile, verifyTrustedDirectory } from "./private-fs"

export type SnapshotScope = "global" | "project"

export type SnapshotTopic = {
  readonly scope: SnapshotScope
  readonly slug: string
  readonly sha256: string
  readonly bytes: number
  readonly mtimeMs: number
  readonly type: MemoryType
  readonly description: string
  readonly body: string
}

export type SnapshotIndex = {
  readonly scope: SnapshotScope
  readonly sha256: string
  readonly bytes: number
  readonly raw: string
}

export type MemorySnapshot = {
  readonly version: 1
  readonly sha256: string
  readonly totalBytes: number
  readonly oldestTopicMtimeMs: number | null
  readonly topics: readonly SnapshotTopic[]
  readonly indexes: readonly SnapshotIndex[]
}

export type CurationStores = {
  readonly global: string
  readonly project: string
}

export type SnapshotCheckpoint = {
  readonly phase: "after-descriptor-reads" | "before-index-open" | "before-topic-open"
  readonly scope: SnapshotScope
  readonly slug?: string
}

export type SnapshotFault = (checkpoint: SnapshotCheckpoint) => void | Promise<void>

export class SnapshotError extends Error {
  readonly name = "SnapshotError"
  constructor(readonly detail: string) {
    super(`memory snapshot rejected: ${detail}`)
  }
}

function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex")
}

export function snapshotSha256(topics: readonly SnapshotTopic[], indexes: readonly SnapshotIndex[]): string {
  const canonical = {
    version: 1,
    topics: topics.map(({ mtimeMs: _mtimeMs, ...topic }) => topic),
    indexes,
  }
  return sha256(JSON.stringify(canonical))
}

function decode(buffer: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer)
  } catch (error) {
    if (error instanceof TypeError) throw new SnapshotError(`${label} is not valid UTF-8`)
    throw error
  }
}

function snapshotFileError(scope: SnapshotScope, label: string, error: unknown): SnapshotError {
  if (error instanceof PrivatePathError) {
    if (error.detail === "symlink") return new SnapshotError(`${scope}${label} is a symlink`)
    return new SnapshotError(`${scope}${label} is not a regular file`)
  }
  if (error instanceof Error && "code" in error && error.code === "ELOOP") return new SnapshotError(`${scope}${label} is a symlink`)
  throw error
}

async function readIndex(scope: SnapshotScope, dir: string, fault?: SnapshotFault): Promise<SnapshotIndex> {
  const path = join(dir, INDEX_FILENAME)
  await fault?.({ phase: "before-index-open", scope })
  try {
    const { bytes } = await readRegularFile(path)
    const raw = decode(bytes, `${scope} index`)
    const secret = scanForSecret(raw)
    if (secret !== null) throw new SnapshotError(`${scope} index contains a secret (${secret.kind})`)
    return { scope, sha256: sha256(bytes), bytes: bytes.length, raw }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { scope, sha256: sha256(""), bytes: 0, raw: "" }
    throw snapshotFileError(scope, " index", error)
  }
}

async function readTopics(scope: SnapshotScope, dir: string, config: CurationConfig, fault?: SnapshotFault): Promise<readonly SnapshotTopic[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
  const topics: SnapshotTopic[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || entry.name === INDEX_FILENAME || !entry.name.endsWith(".md")) continue
    const slug = entry.name.slice(0, -3)
    if (entry.isSymbolicLink()) throw new SnapshotError(`${scope}:${slug} is a symlink`)
    if (!entry.isFile()) continue
    if (!isValidSlug(slug)) throw new SnapshotError(`${scope}:${slug} has an invalid slug`)
    const path = join(dir, entry.name)
    await fault?.({ phase: "before-topic-open", scope, slug })
    try {
      const { bytes, info } = await readRegularFile(path)
      if (bytes.length > config.maxTopicBytes) throw new SnapshotError(`${scope}:${slug} exceeds maxTopicBytes`)
      const raw = decode(bytes, `${scope}:${slug}`)
      const secret = scanForSecret(raw)
      if (secret !== null) throw new SnapshotError(`${scope}:${slug} contains a secret (${secret.kind})`)
      const parsed = parseMemory(raw)
      if (parsed.frontmatter.name !== slug) throw new SnapshotError(`${scope}:${slug} frontmatter name does not match its slug`)
      if (!isSafeDescription(parsed.frontmatter.description)) throw new SnapshotError(`${scope}:${slug} description is not one safe physical line`)
      topics.push({
        scope,
        slug,
        sha256: sha256(bytes),
        bytes: bytes.length,
        mtimeMs: info.mtimeMs,
        type: parsed.frontmatter.type,
        description: parsed.frontmatter.description,
        body: parsed.body,
      })
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") throw error
      if (error instanceof PrivatePathError || (error instanceof Error && "code" in error && error.code === "ELOOP")) throw snapshotFileError(scope, `:${slug}`, error)
      if (error instanceof SnapshotError) throw error
      if (error instanceof Error) throw new SnapshotError(`${scope}:${slug} is malformed: ${error.message}`)
      throw error
    }
  }
  return topics
}

export async function captureSnapshot(stores: CurationStores, config: CurationConfig, fault?: SnapshotFault): Promise<MemorySnapshot> {
  const [globalRoot, projectRoot] = await Promise.all([captureTrustedDirectory(stores.global), captureTrustedDirectory(stores.project)])
  const [globalTopics, projectTopics, globalIndex, projectIndex] = await Promise.all([
    readTopics("global", stores.global, config, fault),
    readTopics("project", stores.project, config, fault),
    readIndex("global", stores.global, fault),
    readIndex("project", stores.project, fault),
  ])
  await fault?.({ phase: "after-descriptor-reads", scope: "global" })
  await Promise.all([verifyTrustedDirectory(globalRoot), verifyTrustedDirectory(projectRoot)])
  const topics = [...globalTopics, ...projectTopics]
  const indexes = [globalIndex, projectIndex]
  if (topics.length > config.maxTopics) throw new SnapshotError(`topic count ${topics.length} exceeds maxTopics`)
  const totalBytes = topics.reduce((total, topic) => total + topic.bytes, 0) + indexes.reduce((total, index) => total + index.bytes, 0)
  if (totalBytes > config.maxInputBytes) throw new SnapshotError(`input bytes ${totalBytes} exceed maxInputBytes`)
  return {
    version: 1,
    sha256: snapshotSha256(topics, indexes),
    totalBytes,
    oldestTopicMtimeMs: topics.length === 0 ? null : Math.min(...topics.map((topic) => topic.mtimeMs)),
    topics,
    indexes,
  }
}
