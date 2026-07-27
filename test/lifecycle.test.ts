import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MEMORY_BLOCK_SENTINEL, buildSystemBlock, injectInto } from "../src/prompt"
import { SecretDetectedError, createStore } from "../src/store"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-e2e-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("memory lifecycle: inject → save → re-inject", () => {
  test("an empty store injects a block with no fenced index", async () => {
    const system: string[] = []
    injectInto(system, { project: await createStore(dir).readIndexForInjection(), global: { content: "", truncated: false } })
    expect(system[0]?.split("\n", 1)[0]).toBe(MEMORY_BLOCK_SENTINEL)
    expect(system[0]).not.toContain("```")
  })

  test("a saved memory shows up in the next injected index", async () => {
    const store = createStore(dir)
    await store.save({ type: "user", slug: "user-role", description: "senior SF engineer, terse replies", body: "Prefers pnpm and does not want trailing summaries." })
    const block = buildSystemBlock({ project: { content: "", truncated: false }, global: await store.readIndexForInjection() })
    expect(block).toContain("](user-role.md)")
    expect(block).toContain("terse replies")
  })

  test("re-saving a slug keeps one pointer and updates its hook", async () => {
    const store = createStore(dir)
    await store.save({ type: "feedback", slug: "verify-policy", description: "run bun test before done", body: "Run the relevant Bun tests before reporting completion." })
    await store.save({ type: "feedback", slug: "verify-policy", description: "run bun test AND tsc before done", body: "Run Bun tests and TypeScript checks before completion." })
    const index = await readFile(join(dir, "MEMORY.md"), "utf8")
    expect(index.split("\n").filter((l) => l.includes("](verify-policy.md)")).length).toBe(1)
    expect(index).toContain("AND tsc")
  })

  test("a credential in the body is rejected end-to-end", async () => {
    const body = `token=ghp_${"a".repeat(36)}`
    await expect(createStore(dir).save({ type: "reference", slug: "token", description: "prod api", body })).rejects.toBeInstanceOf(SecretDetectedError)
  })
})
