import type { Plugin } from "@opencode-ai/plugin"
import { basename } from "node:path"
import { initializeMemoryRoots, initializeProjectStoreRoot, resolveProjectMemoryDir } from "./config"
import { parseCurationOptions } from "./curation-config"
import { createCurationTools, createUnavailableCurationTools } from "./curation-tools"
import { createMemoryRecallTool } from "./memory-recall"
import { createOpenCodeCurationClient } from "./opencode-client"
import { createCurationService } from "./orchestrator"
import { createMemorySaveTool, createSessionClassifier, injectMemoryForSession, type ProjectStoreAccess } from "./runtime"
import { createStore } from "./store"

const memoryPlugin: Plugin = async ({ project, client, directory }, options) => {
  const curationConfig = parseCurationOptions(options)
  await initializeMemoryRoots()
  const globalStore = createStore()
  let projectStore: ProjectStoreAccess
  try {
    const projectDir = await resolveProjectMemoryDir(project, directory)
    await initializeProjectStoreRoot(projectDir)
    projectStore = { kind: "available", store: createStore(projectDir) }
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
  const curationSetup = projectStore.kind === "available"
    ? (() => {
        const service = createCurationService({
          client: createOpenCodeCurationClient(client, directory),
          stores: { global: globalStore.dir, project: projectStore.store.dir },
          globalDir: globalStore.dir,
          namespace: basename(projectStore.store.dir),
          directory,
          config: curationConfig,
        })
        return { service, tools: createCurationTools(service) }
      })()
    : { service: undefined, tools: createUnavailableCurationTools() }
  const curation = curationSetup.service

  return {
    "experimental.chat.system.transform": async (input, output) => {
      await injectMemoryForSession(runtime, input.sessionID, output.system)
    },
    event: async ({ event }) => {
      await curation?.handleEvent(event)
    },
    dispose: async () => {
      await curation?.dispose()
    },
    tool: { memory_save: memorySave, memory_recall: memoryRecall, ...curationSetup.tools },
  }
}

export default memoryPlugin
