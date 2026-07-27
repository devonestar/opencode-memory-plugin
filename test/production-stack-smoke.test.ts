import { describe, expect, test } from "bun:test"
import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { tool } from "@opencode-ai/plugin"
import memoryPlugin from "../src/index"
import { resolveOpenCodeConfigRoot } from "./config-root"

const CONFIG_ROOT = resolveOpenCodeConfigRoot()
const OMO_ENTRY = join(homedir(), ".cache", "opencode", "packages", "oh-my-openagent@latest", "node_modules", "oh-my-openagent", "dist", "index.js")
const AUTH_ENTRY = join(homedir(), ".cache", "opencode", "packages", "opencode-claude-auth@latest", "node_modules", "opencode-claude-auth", "opencode-claude-auth.js")

const configSchema = tool.schema.object({
  plugin: tool.schema.tuple([
    tool.schema.literal("oh-my-openagent@latest"),
    tool.schema.literal("opencode-claude-auth@latest"),
    tool.schema.tuple([
      tool.schema.literal("/Users/devvy/sandbox/opencode-memory-plugin/src/index.ts"),
      tool.schema.object({ curation: tool.schema.object({ enabled: tool.schema.literal(true), allowProviderEgress: tool.schema.literal(true) }).passthrough() }).strict(),
    ]),
  ]),
}).passthrough()

describe("isolated production stack", () => {
  test("loads the OMO, auth, and memory plugin tuple with hidden curation surfaces", async () => {
    const raw = await readFile(join(CONFIG_ROOT, "opencode.jsonc"), "utf8")
    const parsed = configSchema.parse(JSON.parse(raw))

    const [omo, auth] = await Promise.all([import(OMO_ENTRY), import(AUTH_ENTRY)])
    expect(omo.default).toHaveProperty("id", "oh-my-openagent")
    expect(omo.default.server).toBeFunction()
    expect(auth.default).toBeFunction()
    expect(memoryPlugin).toBeFunction()
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
