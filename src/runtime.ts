import { tool } from "@opencode-ai/plugin"
import { INDEX_MAX_BYTES, INDEX_TARGET_RATIO } from "./config"
import type { CurationSuggestion, CurationSuggestionRepository } from "./curation-suggestions"
import { MEMORY_TYPES } from "./frontmatter"
import { isSafeDescription, MEMORY_SCOPES, type MemoryScope, SaveGateError, validateSaveInput } from "./gate"
import { DEFAULT_INJECTION_CONFIG, type InjectionConfig } from "./injection-config"
import { buildSystemBlock, buildSystemBlockResult, hasMemoryBlock, type InjectableSuggestion } from "./prompt"
import { PathContainmentError, type MemoryStore, type SaveOutcome } from "./store"

export type SessionClassification = "primary" | "child" | "unknown"
export type ClassifySession = (sessionID: string | undefined) => Promise<SessionClassification>

type SessionRecord = {
  readonly parentID?: string
}

type SessionResolver = (sessionID: string) => Promise<SessionRecord | undefined>

export type ScopeStoreAccess =
  | { readonly kind: "ready"; readonly store: MemoryStore }
  | { readonly kind: "blocked" }
  | { readonly kind: "unavailable"; readonly reason: string }

export type ProjectStoreAccess = ScopeStoreAccess

export type MemoryRuntime = {
  readonly globalStore: ScopeStoreAccess
  readonly projectStore: ProjectStoreAccess
  readonly classifySession: ClassifySession
  readonly suggestionRepository?: Pick<CurationSuggestionRepository, "claim">
}

const EMPTY_INDEX = { content: "", truncated: false } as const
const SUGGESTION_DELIVERY_LIMIT = 3

type StoreSelection =
  | { readonly kind: "ready"; readonly target: MemoryStore; readonly other?: MemoryStore; readonly otherScope?: MemoryScope }
  | { readonly kind: "rejected"; readonly reason: "RECOVERY_BLOCKED" | "PROJECT_UNAVAILABLE" | "STORE_UNAVAILABLE" }

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

export async function injectMemoryForSession(
  runtime: MemoryRuntime,
  sessionID: string | undefined,
  system: string[],
  config: InjectionConfig = DEFAULT_INJECTION_CONFIG,
): Promise<void> {
  if (hasMemoryBlock(system)) return
  const classification = await runtime.classifySession(sessionID)
  // Unknown reads fail open: ~2KB of extra context is cheaper than silently disabling memory; confirmed children remain excluded.
  if (classification === "child") return
  if (runtime.globalStore.kind !== "ready") return
  const global = await runtime.globalStore.store.readIndexForInjection().catch(() => null)
  if (global === null) return
  const project =
    runtime.projectStore.kind === "ready" ? await runtime.projectStore.store.readIndexForInjection().catch(() => EMPTY_INDEX) : EMPTY_INDEX
  if (hasMemoryBlock(system)) return
  const indexes = { project, global }
  const reservationIndex = system.length
  system.push(buildSystemBlock(indexes, config))
  if (classification !== "primary" || runtime.suggestionRepository === undefined) return
  const claimed = await runtime.suggestionRepository.claim(SUGGESTION_DELIVERY_LIMIT, (candidate) => {
    const result = buildSystemBlockResult(indexes, config, injectableSuggestions(candidate))
    return result.retainedSuggestionCount === candidate.length
  }).catch(() => null)
  if (claimed === null) return
  system[reservationIndex] = buildSystemBlock(indexes, config, injectableSuggestions(claimed))
}

function injectableSuggestions(suggestions: readonly CurationSuggestion[]): readonly InjectableSuggestion[] {
  return suggestions.map((suggestion) => ({
    kind: suggestion.kind,
    reasonCode: suggestion.reasonCode,
    sourceSlugs: suggestion.sources.map((source) => `${source.scope}:${source.slug}`),
    sourceCount: suggestion.sources.length,
    destination: suggestion.destination,
    runId: suggestion.runId,
    operationId: suggestion.operationId,
  }))
}

function selectStores(runtime: MemoryRuntime, scope: MemoryScope): StoreSelection {
  switch (scope) {
    case "global": {
      if (runtime.globalStore.kind === "blocked") return { kind: "rejected", reason: "RECOVERY_BLOCKED" }
      if (runtime.globalStore.kind === "unavailable") return { kind: "rejected", reason: "STORE_UNAVAILABLE" }
      return runtime.projectStore.kind === "ready"
        ? { kind: "ready", target: runtime.globalStore.store, other: runtime.projectStore.store, otherScope: "project" }
        : { kind: "ready", target: runtime.globalStore.store }
    }
    case "project": {
      if (runtime.projectStore.kind === "blocked") return { kind: "rejected", reason: "RECOVERY_BLOCKED" }
      if (runtime.projectStore.kind === "unavailable") return { kind: "rejected", reason: "PROJECT_UNAVAILABLE" }
      return runtime.globalStore.kind === "ready"
        ? { kind: "ready", target: runtime.projectStore.store, other: runtime.globalStore.store, otherScope: "global" }
        : { kind: "ready", target: runtime.projectStore.store }
    }
    default:
      return scope
  }
}
