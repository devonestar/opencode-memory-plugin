import { tool } from "@opencode-ai/plugin"
import { INDEX_MAX_BYTES, INDEX_TARGET_RATIO } from "./config"
import { MEMORY_TYPES } from "./frontmatter"
import { isSafeDescription, MEMORY_SCOPES, type MemoryScope, SaveGateError, validateSaveInput } from "./gate"
import { injectInto } from "./prompt"
import { PathContainmentError, type MemoryStore, type SaveOutcome } from "./store"

export type SessionClassification = "primary" | "child" | "unknown"
export type ClassifySession = (sessionID: string | undefined) => Promise<SessionClassification>

type SessionRecord = {
  readonly parentID?: string
}

type SessionResolver = (sessionID: string) => Promise<SessionRecord | undefined>

export type ProjectStoreAccess =
  | { readonly kind: "available"; readonly store: MemoryStore }
  | { readonly kind: "unavailable"; readonly reason: string }

export type MemoryRuntime = {
  readonly globalStore: MemoryStore
  readonly projectStore: ProjectStoreAccess
  readonly classifySession: ClassifySession
}

const EMPTY_INDEX = { content: "", truncated: false } as const

type StoreSelection =
  | { readonly kind: "ready"; readonly target: MemoryStore; readonly other?: MemoryStore; readonly otherScope?: MemoryScope }
  | { readonly kind: "rejected"; readonly reason: string }

function sizeNote(outcome: SaveOutcome): string {
  if (outcome.over) {
    const target = Math.floor(INDEX_MAX_BYTES * INDEX_TARGET_RATIO)
    return ` WARNING: index is ${outcome.indexBytes}B, over the ${INDEX_MAX_BYTES}B cap — compact it to ~${target}B: one line per entry, move detail into topic files.`
  }
  if (outcome.warn) return ` Note: index is nearing the ${INDEX_MAX_BYTES}B cap; keep entries terse.`
  return ""
}

export function createSessionClassifier(resolveSession: SessionResolver): ClassifySession {
  const classifications = new Map<string, Promise<SessionClassification>>()
  return async (sessionID) => {
    if (sessionID === undefined) return "unknown"
    const cached = classifications.get(sessionID)
    if (cached !== undefined) return cached
    const pending = resolveSession(sessionID)
      .then((session): SessionClassification => {
        if (session === undefined) return "unknown"
        return session.parentID === undefined ? "primary" : "child"
      })
      .catch((): SessionClassification => "unknown")
    classifications.set(sessionID, pending)
    return pending
  }
}

export function createMemorySaveTool(runtime: MemoryRuntime) {
  return tool({
    description:
      "Persist a durable cross-session learning to an explicit storage scope. Choose global for person-level preferences, org-wide systems, and workflows applying across essentially all workspaces. Choose project for facts specific to this repository, product, or codebase. If uncertain, choose project. Type and scope are orthogonal: type project does not imply project storage. Writes the topic before its index pointer under a per-store lock. Use only for non-derivable facts, never code, paths, git history, fix recipes, or secrets. Invoke the memory-types skill first for body structure.",
    args: {
      scope: tool.schema
        .enum(MEMORY_SCOPES)
        .describe(
          'REQUIRED storage destination: global — person-level preferences, org-wide systems, and workflows applying across essentially all workspaces; project — facts specific to this repository, product, or codebase. If uncertain, choose project. Type and scope are orthogonal: type: "project" does NOT imply project storage.',
        ),
      type: tool.schema
        .enum(MEMORY_TYPES)
        .describe('memory content type: user | feedback | project | reference; orthogonal to scope, so type: "project" does NOT imply project storage'),
      slug: tool.schema.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe("kebab-case filename stem, e.g. user-role"),
      description: tool.schema.string().min(1).max(200).refine(isSafeDescription, "description must be one physical line without NUL or code-fence backticks").describe("one-line index hook; be specific — used for recall relevance"),
      body: tool.schema.string().min(1).describe("the memory; for feedback/project: rule + **Why:** + **How to apply:**"),
    },
    execute: async (args, context) => {
      const classification = await runtime.classifySession(context.sessionID)
      if (classification === "child") {
        return {
          title: "memory_save rejected",
          output: "refused to save from a child session: only the primary session persists memory; hand this finding to the parent session",
        }
      }
      if (classification === "unknown") {
        return {
          title: "memory_save rejected",
          output: "refused to save because the session could not be verified as primary; only a verified primary session may persist memory",
        }
      }

      const stores = selectStores(runtime, args.scope)
      if (stores.kind === "rejected") return { title: "memory_save rejected", output: stores.reason }

      try {
        const duplicate = stores.other === undefined ? false : await stores.other.hasSlug(args.slug)
        validateSaveInput(args, duplicate ? (stores.otherScope ?? null) : null)
        const outcome = await stores.target.save(args)
        const status = outcome.created ? "saved" : "updated"
        return { title: `memory ${status}: ${args.slug}`, output: `${status} ${args.slug} (${args.type}, ${args.scope}).${sizeNote(outcome)}` }
      } catch (error) {
        if (error instanceof SaveGateError || error instanceof PathContainmentError) {
          return { title: "memory_save rejected", output: error.message }
        }
        throw error
      }
    },
  })
}

export async function injectMemoryForSession(runtime: MemoryRuntime, sessionID: string | undefined, system: string[]): Promise<void> {
  const classification = await runtime.classifySession(sessionID)
  // Unknown reads fail open: ~2KB of extra context is cheaper than silently disabling memory; confirmed children remain excluded.
  if (classification === "child") return
  const global = await runtime.globalStore.readIndexForInjection().catch(() => null)
  if (global === null) return
  const project =
    runtime.projectStore.kind === "available" ? await runtime.projectStore.store.readIndexForInjection().catch(() => EMPTY_INDEX) : EMPTY_INDEX
  injectInto(system, { project, global })
}

function selectStores(runtime: MemoryRuntime, scope: MemoryScope): StoreSelection {
  switch (scope) {
    case "global":
      return runtime.projectStore.kind === "available"
        ? { kind: "ready", target: runtime.globalStore, other: runtime.projectStore.store, otherScope: "project" }
        : { kind: "ready", target: runtime.globalStore }
    case "project":
      return runtime.projectStore.kind === "available"
        ? { kind: "ready", target: runtime.projectStore.store, other: runtime.globalStore, otherScope: "global" }
        : { kind: "rejected", reason: `project scope unavailable: ${runtime.projectStore.reason}; no global fallback was used` }
    default:
      return scope
  }
}
