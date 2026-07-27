/** The four Claude-Code memory types. `user` is always private; the rest bias by scope. */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export type MemoryFrontmatter = {
  readonly name: string
  readonly description: string
  readonly type: MemoryType
}

export type ParsedMemory = {
  readonly frontmatter: MemoryFrontmatter
  readonly body: string
}

/** Thrown when a memory file cannot be parsed back into a typed value. */
export class MemoryParseError extends Error {
  readonly name = "MemoryParseError"
  constructor(readonly reason: string) {
    super(`memory parse failed: ${reason}`)
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/

export function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value)
}

/** A slug is the topic filename stem; the charset alone guarantees no path traversal. */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug)
}

/** Render a memory file with `metadata.type` nesting, matching Claude Code's format. */
export function serializeMemory(fm: MemoryFrontmatter, body: string): string {
  return ["---", `name: ${fm.name}`, `description: ${fm.description}`, "metadata:", `  type: ${fm.type}`, "---", "", body.trimEnd(), ""].join("\n")
}

export function parseMemory(raw: string): ParsedMemory {
  const match = raw.match(FRONTMATTER_RE)
  if (match === null) throw new MemoryParseError("missing frontmatter block")
  const head = match[1] ?? ""
  const body = (match[2] ?? "").trim()
  const name = readScalar(head, "name")
  const description = readScalar(head, "description")
  const type = readType(head)
  if (name === null) throw new MemoryParseError("missing name")
  if (description === null) throw new MemoryParseError("missing description")
  if (type === null) throw new MemoryParseError("missing or invalid metadata.type")
  return { frontmatter: { name, description, type }, body }
}

function readScalar(head: string, key: string): string | null {
  const line = head.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"))
  if (line === null) return null
  const value = (line[1] ?? "").trim()
  return value.length > 0 ? value : null
}

function readType(head: string): MemoryType | null {
  const nested = head.match(/^[ \t]+type:[ \t]*(.+)$/m)
  const flat = head.match(/^type:[ \t]*(.+)$/m)
  const value = (nested ?? flat)?.[1]?.trim() ?? ""
  return isMemoryType(value) ? value : null
}
