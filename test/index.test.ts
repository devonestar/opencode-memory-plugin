import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient, type Model } from "@opencode-ai/sdk"
import memoryPlugin from "../src/index"
import * as pluginModule from "../src/index"
import { MEMORY_BLOCK_SENTINEL } from "../src/prompt"

const MODEL = {
  id: "test-model",
  providerID: "test-provider",
  api: { id: "test-api", url: "http://127.0.0.1", npm: "test-provider" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 10_000 },
  status: "active",
  options: {},
  headers: {},
} satisfies Model

const PLUGIN_INPUT = {
  client: createOpencodeClient({ baseUrl: "http://127.0.0.1:1" }),
  project: { id: "global", worktree: "/", time: { created: 0 } },
  directory: "/",
  worktree: "/",
  experimental_workspace: { register: () => undefined },
  serverUrl: new URL("http://127.0.0.1:1"),
  $: Bun.$,
} satisfies PluginInput

describe("plugin module entrypoint", () => {
  test("exports only the default plugin factory", () => {
    expect(Object.keys(pluginModule)).toEqual(["default"])
  })

  test("a realistic factory invocation injects one memory block", async () => {
    // Given a non-git PluginInput matching opencode's root-worktree behavior
    const hooks = await memoryPlugin(PLUGIN_INPUT)
    const transform = hooks["experimental.chat.system.transform"]
    if (transform === undefined) throw new TypeError("memory system transform is missing")
    const system: string[] = ["base prompt"]

    // When opencode invokes the returned system transform without a session id
    await transform({ model: MODEL }, { system })

    // Then exactly one memory block is injected without invoking another export as a plugin
    expect(system.filter((entry) => entry.split("\n", 1)[0] === MEMORY_BLOCK_SENTINEL).length).toBe(1)
  })

  test("registers all tools without curation hooks when the project scope is unavailable", async () => {
    // Given a realistic factory invocation without tuple options
    const hooks = await memoryPlugin(PLUGIN_INPUT)

    // When the returned hooks are inspected
    const tools = hooks.tool ?? {}

    // Then unavailable curation tools remain discoverable without an unusable event service
    expect(Object.keys(tools).sort()).toEqual([
      "memory_archive",
      "memory_curation_control",
      "memory_curation_run",
      "memory_curation_status",
      "memory_delete",
      "memory_recall",
      "memory_recall_archive",
      "memory_restore",
      "memory_save",
    ])
    expect(hooks.event).toBeUndefined()
    expect(hooks.dispose).toBeUndefined()
  })

  test("rejects unknown tuple curation options at plugin initialization", async () => {
    // Given a tuple option with a misspelled curation field
    const options = { curation: { cooldownHour: 24 } }

    // When and Then the plugin initializes
    await expect(memoryPlugin(PLUGIN_INPUT, options)).rejects.toThrow("cooldownHour")
  })
})
