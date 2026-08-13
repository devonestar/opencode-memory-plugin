import { tool } from "@opencode-ai/plugin"
import { isValidSlug } from "./frontmatter"
import type { MemoryScope } from "./gate"
import { parseEntryId, type LifecycleSource } from "./lifecycle-schema"
import type { LifecycleRemovalResult, LifecycleRestoreResult } from "./lifecycle-service"
import type { ClassifySession } from "./runtime"

type LifecycleService = {
  readonly archive: (request: { readonly scope: MemoryScope; readonly slug: string }) => Promise<LifecycleRemovalResult>
  readonly delete: (request: { readonly scope: MemoryScope; readonly slug: string }) => Promise<LifecycleRemovalResult>
  readonly restore: (request: { readonly scope: MemoryScope; readonly source: LifecycleSource; readonly entryId: unknown }) => Promise<LifecycleRestoreResult>
}

type ReadyLifecycle = {
  readonly kind: "ready"
  readonly storeRoot: string
  readonly service: LifecycleService
}

type LifecycleAccess = ReadyLifecycle | { readonly kind: "blocked" } | { readonly kind: "unavailable" }

export type LifecycleToolRuntime = {
  readonly classifySession: ClassifySession
  readonly global: LifecycleAccess
  readonly project: LifecycleAccess
}

type SuccessMetadata = {
  readonly slug: string
  readonly scope: MemoryScope
  readonly source: LifecycleSource
}

const SCOPES = ["global", "project"] as const
const SOURCES = ["archive", "trash"] as const
const slugSchema = tool.schema.string().refine(isValidSlug, "unsafe slug")
const scopeSchema = tool.schema.enum(SCOPES)
const entryIdSchema = tool.schema.string().uuid()

function response(title: string, value: Readonly<Record<string, unknown>>) {
  return { title, output: JSON.stringify(value) }
}

function failure(title: string, error: string) {
  return response(title, { ok: false, error })
}

function select(runtime: LifecycleToolRuntime, scope: MemoryScope): LifecycleAccess {
  return scope === "global" ? runtime.global : runtime.project
}

async function authorize(runtime: LifecycleToolRuntime, sessionID: string | undefined, title: string): Promise<ReturnType<typeof failure> | null> {
  const classification = await runtime.classifySession(sessionID)
  switch (classification) {
    case "primary":
      return null
    case "child":
    case "unknown":
      return failure(title, "SESSION_NOT_VERIFIED")
    default: {
      const exhaustive: never = classification
      return exhaustive
    }
  }
}

function unavailable(title: string, scope: MemoryScope, access: LifecycleAccess) {
  switch (access.kind) {
    case "ready":
      return null
    case "blocked":
      return failure(title, "RECOVERY_BLOCKED")
    case "unavailable":
      return failure(title, scope === "global" ? "STORE_UNAVAILABLE" : "PROJECT_UNAVAILABLE")
    default: {
      const exhaustive: never = access
      return exhaustive
    }
  }
}

function mappedRemoval(title: string, result: LifecycleRemovalResult, metadata: SuccessMetadata) {
  if (!result.ok) return failure(title, result.code)
  return response(title, {
    ok: true,
    code: result.code,
    entry_id: result.entryId,
    slug: metadata.slug,
    scope: metadata.scope,
    source: metadata.source,
  })
}

function mappedRestore(title: string, result: LifecycleRestoreResult, metadata: Omit<SuccessMetadata, "slug">) {
  if (!result.ok) return failure(title, result.code)
  return response(title, { ok: true, code: result.code, entry_id: result.entryId, slug: result.slug, scope: metadata.scope, source: metadata.source })
}

function createRemovalTool(runtime: LifecycleToolRuntime, operation: "archive" | "delete") {
  const title = operation === "archive" ? "memory_archive" : "memory_delete"
  return tool({
    description: operation === "archive"
      ? "Archive one active memory in an explicit scope only on an explicit user request; the request is sufficient authorization, with no second confirmation."
      : "Move one active memory to user trash in an explicit scope only on an explicit user request; the request is sufficient authorization, with no second confirmation.",
    args: { scope: scopeSchema, slug: slugSchema },
    execute: async (args, context) => {
      const rejected = await authorize(runtime, context.sessionID, title)
      if (rejected !== null) return rejected
      const access = select(runtime, args.scope)
      const inaccessible = unavailable(title, args.scope, access)
      if (inaccessible !== null) return inaccessible
      if (access.kind !== "ready") return failure(title, "PROJECT_UNAVAILABLE")
      const result = operation === "archive"
        ? await access.service.archive({ scope: args.scope, slug: args.slug })
        : await access.service.delete({ scope: args.scope, slug: args.slug })
      return mappedRemoval(title, result, { slug: args.slug, scope: args.scope, source: operation === "archive" ? "archive" : "trash" })
    },
  })
}

export function createLifecycleTools(runtime: LifecycleToolRuntime) {
  return {
    memory_archive: createRemovalTool(runtime, "archive"),
    memory_delete: createRemovalTool(runtime, "delete"),
    memory_restore: tool({
      description: "Restore one exact archived or trashed memory entry only on an explicit user request; the request is sufficient authorization, with no second confirmation, overwrite, merge, or rename.",
      args: { scope: scopeSchema, source: tool.schema.enum(SOURCES), entry_id: entryIdSchema },
      execute: async (args, context) => {
        const title = "memory_restore"
        const rejected = await authorize(runtime, context.sessionID, title)
        if (rejected !== null) return rejected
        const access = select(runtime, args.scope)
        const inaccessible = unavailable(title, args.scope, access)
        if (inaccessible !== null) return inaccessible
        if (access.kind !== "ready") return failure(title, "PROJECT_UNAVAILABLE")
        const entryId = parseEntryId(args.entry_id)
        const result = await access.service.restore({ scope: args.scope, source: args.source, entryId })
        return mappedRestore(title, result, { scope: args.scope, source: args.source })
      },
    }),
  }
}
