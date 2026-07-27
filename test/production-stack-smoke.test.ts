import { describe, expect, test } from "bun:test"
import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { tool } from "@opencode-ai/plugin"
import memoryPlugin from "../src/index"
import { resolveOpenCodeConfigRoot } from "./config-root"

const CONFIG_ROOT = resolveOpenCodeConfigRoot()
const MEMORY_PLUGIN_URL = pathToFileURL(join(import.meta.dir, "..", "src", "index.ts")).href
const pluginEntrySchema = tool.schema.union([
  tool.schema.string(),
  tool.schema.tuple([tool.schema.string(), tool.schema.unknown()]),
])

const configSchema = tool.schema.object({
  plugin: tool.schema.tuple([
    tool.schema.literal("oh-my-openagent@latest"),
    tool.schema.literal("opencode-claude-auth@latest"),
    tool.schema.tuple([
      tool.schema.literal(MEMORY_PLUGIN_URL),
      tool.schema.object({ curation: tool.schema.object({ enabled: tool.schema.literal(true), allowProviderEgress: tool.schema.literal(true) }).passthrough() }).passthrough(),
    ]),
  ]).rest(pluginEntrySchema),
}).passthrough()

describe("effective production stack", () => {
  test("contains no checkout literals or dynamic package-cache imports", async () => {
    const source = await readFile(import.meta.path, "utf8")

    expect(source).not.toMatch(/(["'`])(?:file:\/\/\/|\/)[^"'`\r\n]+\1/)
    expect(source).not.toMatch(/["'`]~\/\.cache\//)
    expect(source).not.toMatch(/\bhomedir\b/)
    expect(source).not.toMatch(/\bimport\s*\(/)
  })

  test("loads the OMO, auth, and memory plugin tuple with hidden curation surfaces", async () => {
    const configProcess = Bun.spawn(["opencode", "debug", "config"], {
      cwd: join(import.meta.dir, ".."),
      stderr: "pipe",
      stdout: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      configProcess.exited,
      new Response(configProcess.stdout).text(),
      new Response(configProcess.stderr).text(),
    ])

    expect(exitCode, `opencode debug config stderr:\n${stderr.length > 0 ? stderr : "<empty>"}`).toBe(0)
    const rawConfig: unknown = await new Response(stdout).json()
    const parsed = configSchema.parse(rawConfig)

    expect(memoryPlugin).toBeFunction()
    expect(parsed.plugin[0]).toBe("oh-my-openagent@latest")
    expect(parsed.plugin[1]).toBe("opencode-claude-auth@latest")
    expect(parsed.plugin[2][0]).toBe(MEMORY_PLUGIN_URL)
    expect(parsed.plugin[2][1].curation).toMatchObject({ enabled: true, allowProviderEgress: true })

    const agent = await readFile(join(CONFIG_ROOT, "agent", "memory-curator.md"), "utf8")
    expect(agent.match(/^hidden:\s*(\w+)$/m)?.[1]).toBe("true")
    expect(agent.match(/^mode:\s*(\w+)$/m)?.[1]).toBe("subagent")
    for (const command of ["memory-review.md", "memory-curation-run.md", "memory-curation-status.md", "memory-curation-pause.md", "memory-curation-resume.md"]) {
      await expect(access(join(CONFIG_ROOT, "command", command))).resolves.toBeNull()
    }
    await expect(access(join(CONFIG_ROOT, "command", "memory-curation-restore.md"))).rejects.toBeDefined()
  })
})
