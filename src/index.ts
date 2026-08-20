import type { Plugin } from "@opencode-ai/plugin"
import { basename } from "node:path"
import { initializeMemoryRoots, initializeProjectStoreRoot, resolveProjectMemoryDir } from "./config"
import { parseCurationOptions } from "./curation-config"
import { createCurationRuntime } from "./curation-runtime"
import { parseInjectionOptions } from "./injection-config"
import { createLifecycleTools, type LifecycleToolRuntime } from "./lifecycle-tools"
import { recoverLifecycleStore } from "./lifecycle-recovery"
import { createLifecycleService } from "./lifecycle-service"
import { createMemoryRecallTool } from "./memory-recall"
import { createMemoryRecallArchiveTool } from "./memory-recall-archive"
import { createOpenCodeCurationClient } from "./opencode-client"
import { createCurationService } from "./orchestrator"
import { createMemorySaveTool, createSessionClassifier, injectMemoryForSession, type ScopeStoreAccess } from "./runtime"
import { createStore } from "./store"

const memoryPlugin: Plugin = async ({ project, client, directory }, options) => {
  const curationConfig = parseCurationOptions(options)
  const injectionConfig = parseInjectionOptions(options)
  await initializeMemoryRoots()
  const globalRawStore = createStore()
  const globalRecovery = await recoverLifecycleStore({ storeRoot: globalRawStore.dir, scope: "global" })
  const globalStore: ScopeStoreAccess = globalRecovery.ok ? { kind: "ready", store: globalRawStore } : { kind: "blocked" }
  let projectStore: ScopeStoreAccess
  try {
    const projectDir = await resolveProjectMemoryDir(project, directory)
    await initializeProjectStoreRoot(projectDir)
    const store = createStore(projectDir)
    const recovery = await recoverLifecycleStore({ storeRoot: store.dir, scope: "project" })
    projectStore = recovery.ok ? { kind: "ready", store } : { kind: "blocked" }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown namespace resolution failure"
    projectStore = { kind: "unavailable", reason }
  }

  const classifySession = createSessionClassifier(async (sessionID) => {
    const response = await client.session.get({ path: { id: sessionID } })
    return response.data
  })
  const runtime = { globalStore, projectStore, classifySession }
  const memorySave = createMemorySaveTool(runtime)
  const memoryRecall = createMemoryRecallTool(runtime)
  const globalLifecycle: LifecycleToolRuntime["global"] = globalStore.kind === "ready"
    ? { kind: "ready", storeRoot: globalStore.store.dir, service: createLifecycleService({ storeRoot: globalStore.store.dir, scope: "global" }) }
    : globalStore.kind === "blocked" ? { kind: "blocked" } : { kind: "unavailable" }
  const projectLifecycle: LifecycleToolRuntime["project"] = projectStore.kind === "ready"
    ? { kind: "ready", storeRoot: projectStore.store.dir, service: createLifecycleService({ storeRoot: projectStore.store.dir, scope: "project" }) }
    : projectStore.kind === "blocked" ? { kind: "blocked" } : { kind: "unavailable" }
  const lifecycleRuntime = { classifySession, global: globalLifecycle, project: projectLifecycle }
  const lifecycleTools = createLifecycleTools(lifecycleRuntime)
  const memoryRecallArchive = createMemoryRecallArchiveTool(lifecycleRuntime)
  const curationSetup = createCurationRuntime({
    global: globalStore,
    project: projectStore,
    createService: (stores) => createCurationService({
          client: createOpenCodeCurationClient(client, directory),
          stores,
          globalDir: stores.global,
          namespace: basename(stores.project),
          directory,
          config: curationConfig,
        }),
  })
  const curation = curationSetup.service

  return {
    "experimental.chat.system.transform": async (input, output) => {
      await injectMemoryForSession(runtime, input.sessionID, output.system, injectionConfig)
    },
    ...(curation === undefined ? {} : {
      event: async ({ event }) => { await curation.handleEvent(event) },
      dispose: async () => { await curation.dispose() },
    }),
    tool: { memory_save: memorySave, memory_recall: memoryRecall, memory_recall_archive: memoryRecallArchive, ...lifecycleTools, ...curationSetup.tools },
  }
}

export default memoryPlugin
