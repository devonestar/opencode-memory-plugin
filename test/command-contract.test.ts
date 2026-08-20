import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { POINTER_MAX_CHARS } from "../src/config"
import { resolveOpenCodeConfigRoot } from "./config-root"

describe("primary-session command contract", () => {
  // `agent:` frontmatter makes OpenCode run the command in a child session, and verifyRoot in
  // src/orchestrator.ts rejects any session carrying a parentID, so these can never be accepted.
  for (const file of ["memory-curation-run.md", "memory-curation-pause.md", "memory-curation-resume.md"]) {
    test(`${file} does not pin a subagent`, async () => {
      const command = await readFile(join(resolveOpenCodeConfigRoot(), "command", file), "utf8")

      expect(command).not.toMatch(/^agent:/m)
    })
  }
})

describe("memory-review command contract", () => {
  test("does not embed unavailable task-call syntax and shares the pointer cap", async () => {
    const command = await readFile(join(resolveOpenCodeConfigRoot(), "command", "memory-review.md"), "utf8")
    const pointerCap = command.match(/index line over (\d+) characters/)?.[1]

    expect(command).not.toContain("task(")
    expect(command).not.toContain("category=")
    expect(Number(pointerCap)).toBe(POINTER_MAX_CHARS)
  })
})
