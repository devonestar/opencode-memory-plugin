import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { POINTER_MAX_CHARS } from "../src/config"
import { resolveOpenCodeConfigRoot } from "./config-root"

describe("memory-review command contract", () => {
  test("does not embed unavailable task-call syntax and shares the pointer cap", async () => {
    const command = await readFile(join(resolveOpenCodeConfigRoot(), "command", "memory-review.md"), "utf8")
    const pointerCap = command.match(/index line over (\d+) characters/)?.[1]

    expect(command).not.toContain("task(")
    expect(command).not.toContain("category=")
    expect(Number(pointerCap)).toBe(POINTER_MAX_CHARS)
  })
})
