import { tool } from "@opencode-ai/plugin"
import { ArchiveCorpusLimitError, ArchiveCorpusUnreadableError, loadArchiveCorpus } from "./archive-corpus"
import { rankBm25f } from "./bm25f"
import type { LifecycleToolRuntime } from "./lifecycle-tools"

const SCOPES = ["global", "project"] as const
const QUERY_MAX_BYTES = 500
const OUTPUT_MAX_BYTES = 25_000

function failure(error: string) {
  return { title: "memory_recall_archive", output: JSON.stringify({ ok: false, error }) }
}

export function createMemoryRecallArchiveTool(runtime: LifecycleToolRuntime) {
  return tool({
    description: "Search canonical archived memories in one explicit scope and return metadata only.",
    args: {
      query: tool.schema.string()
        .transform((value) => value.trim())
        .refine((value) => value.length > 0, "query must not be empty after trimming")
        .refine((value) => value.isWellFormed(), "query must contain well-formed Unicode")
        .refine((value) => Buffer.byteLength(value, "utf8") <= QUERY_MAX_BYTES, `query must be at most ${QUERY_MAX_BYTES} UTF-8 bytes`),
      scope: tool.schema.enum(SCOPES),
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
      const access = args.scope === "global" ? runtime.global : runtime.project
      if (access.kind === "unavailable") return failure(args.scope === "global" ? "STORE_UNAVAILABLE" : "PROJECT_UNAVAILABLE")
      if (access.kind === "blocked") return failure("RECOVERY_BLOCKED")
      let documents: Awaited<ReturnType<typeof loadArchiveCorpus>>
      try {
        documents = await loadArchiveCorpus(access.storeRoot, args.scope)
      } catch (error) {
        if (error instanceof ArchiveCorpusLimitError) return failure("CORPUS_LIMIT_EXCEEDED")
        if (error instanceof ArchiveCorpusUnreadableError) return failure("STORE_UNAVAILABLE")
        throw error
      }
      const ranked = rankBm25f(args.query, documents)
      const matchedCount = ranked.length
      const results = ranked.slice(0, args.limit).map(({ scope, slug, type, description, score, entryId, archivedAt }) => ({
        scope,
        slug,
        type,
        description,
        score,
        entry_id: entryId,
        archived_at: archivedAt,
      }))
      while (true) {
        const output = JSON.stringify({ ok: true, query: args.query, scope: args.scope, matched_count: matchedCount, result_count: results.length, results_truncated: results.length < matchedCount, results })
        if (Buffer.byteLength(output, "utf8") <= OUTPUT_MAX_BYTES || results.length === 0) return { title: "memory_recall_archive", output }
        results.pop()
      }
    },
  })
}
