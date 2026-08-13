import { tool } from "@opencode-ai/plugin"
import { rankBm25f } from "./bm25f"
import {
  loadRecallCorpus,
  RecallCorpusIncompleteError,
  RecallCorpusUnreadableError,
  type RecallSource,
} from "./recall-corpus"
import type { MemoryRuntime } from "./runtime"

const RECALL_SCOPES = ["all", "global", "project"] as const
const QUERY_MAX_BYTES = 500
const OUTPUT_MAX_BYTES = 25_000

type RecallErrorCode =
  | "SESSION_NOT_VERIFIED"
  | "PROJECT_UNAVAILABLE"
  | "RECOVERY_BLOCKED"
  | "CORPUS_LIMIT_EXCEEDED"
  | "STORE_UNAVAILABLE"

function failure(code: RecallErrorCode) {
  return { title: "memory_recall", output: JSON.stringify({ ok: false, error: code }) }
}

export function createMemoryRecallTool(runtime: MemoryRuntime) {
  return tool({
    description: "Search durable memories with local lexical ranking and return metadata-only matches. Requires a verified primary session.",
    args: {
      query: tool.schema
        .string()
        .transform((value) => value.trim())
        .refine((value) => value.length > 0, "query must not be empty after trimming")
        .refine((value) => value.isWellFormed(), "query must contain well-formed Unicode")
        .refine((value) => Buffer.byteLength(value, "utf8") <= QUERY_MAX_BYTES, `query must be at most ${QUERY_MAX_BYTES} UTF-8 bytes`),
      scope: tool.schema.enum(RECALL_SCOPES).default("all"),
      limit: tool.schema.number().int().min(1).max(10).default(5),
    },
    execute: async (args, context) => {
      const classification = await runtime.classifySession(context.sessionID)
      switch (classification) {
        case "primary":
          break
        case "child":
        case "unknown":
          return failure("SESSION_NOT_VERIFIED")
        default: {
          const exhaustive: never = classification
          return exhaustive
        }
      }

      const sources: readonly RecallSource[] | null = (() => {
        switch (args.scope) {
          case "global":
            return runtime.globalStore.kind === "ready" ? [{ scope: "global", store: runtime.globalStore.store }] : null
          case "project":
            return runtime.projectStore.kind === "ready"
              ? [{ scope: "project", store: runtime.projectStore.store }]
              : null
          case "all":
            return runtime.globalStore.kind === "ready" && runtime.projectStore.kind === "ready"
              ? [
                  { scope: "global", store: runtime.globalStore.store },
                  { scope: "project", store: runtime.projectStore.store },
                ]
              : null
          default: {
            const exhaustive: never = args.scope
            return exhaustive
          }
        }
      })()
      if (sources === null) {
        const blocked = (args.scope === "global" || args.scope === "all") && runtime.globalStore.kind === "blocked"
          || (args.scope === "project" || args.scope === "all") && runtime.projectStore.kind === "blocked"
        if (blocked) return failure("RECOVERY_BLOCKED")
        return failure((args.scope === "global" || args.scope === "all") && runtime.globalStore.kind === "unavailable" ? "STORE_UNAVAILABLE" : "PROJECT_UNAVAILABLE")
      }

      let documents: Awaited<ReturnType<typeof loadRecallCorpus>>
      try {
        documents = await loadRecallCorpus(sources)
      } catch (error) {
        if (error instanceof RecallCorpusIncompleteError) return failure("CORPUS_LIMIT_EXCEEDED")
        if (error instanceof RecallCorpusUnreadableError) return failure("STORE_UNAVAILABLE")
        throw error
      }

      const ranked = rankBm25f(args.query, documents)
      const matchedCount = ranked.length
      const results = ranked.slice(0, args.limit).map(({ scope, slug, type, description, score }) => ({
        scope,
        slug,
        type,
        description,
        score,
      }))

      while (true) {
        const output = JSON.stringify({
          ok: true,
          query: args.query,
          scope: args.scope,
          matched_count: matchedCount,
          result_count: results.length,
          results_truncated: results.length < matchedCount,
          results,
        })
        if (Buffer.byteLength(output, "utf8") <= OUTPUT_MAX_BYTES || results.length === 0) {
          return { title: "memory_recall", output }
        }
        results.pop()
      }
    },
  })
}
