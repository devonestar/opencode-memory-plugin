import { createCurationTools, createUnavailableCurationTools } from "./curation-tools"
import type { CurationService } from "./curation-service-types"
import type { ScopeStoreAccess } from "./runtime"

type CurationRuntimeInput = {
  readonly global: ScopeStoreAccess
  readonly project: ScopeStoreAccess
  readonly createService: (stores: { readonly global: string; readonly project: string }) => CurationService
}

export function createCurationRuntime(input: CurationRuntimeInput) {
  if (input.global.kind !== "ready" || input.project.kind !== "ready") {
    return { service: undefined, tools: createUnavailableCurationTools() }
  }
  const service = input.createService({ global: input.global.store.dir, project: input.project.store.dir })
  return { service, tools: createCurationTools(service) }
}
