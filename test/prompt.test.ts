import { describe, expect, test } from "bun:test"
import { MEMORY_BLOCK_MAX_BYTES, MEMORY_BLOCK_SENTINEL, buildSystemBlock, injectInto } from "../src/prompt"

const EMPTY_INDEX = { content: "", truncated: false } as const

function indexes(projectContent: string, globalContent: string) {
  return {
    project: { content: projectContent, truncated: false },
    global: { content: globalContent, truncated: false },
  }
}

describe("buildSystemBlock", () => {
  test("uses the exact sentinel as its first line", () => {
    const block = buildSystemBlock(indexes("- [x](x.md) — project", "- [y](y.md) — global"))
    expect(block.split("\n", 1)[0]).toBe("<!-- opencode-memory:v2 -->")
  })

  test("renders project and global pointer data in one block", () => {
    const projectPointer = "- [project-fact](project-fact.md) — product detail"
    const globalPointer = "- [user-role](user-role.md) — person preference"
    const block = buildSystemBlock(indexes(projectPointer, globalPointer))
    expect(block).toContain(projectPointer)
    expect(block).toContain(globalPointer)
  })

  test("keeps oversized combined indexes within budget with a 60/40 initial split", () => {
    // Given equally sized oversized indexes
    const project = Array.from({ length: 200 }, (_, index) => `- [p-${index}](p-${index}.md) — ${"p".repeat(90)}`).join("\n")
    const global = Array.from({ length: 200 }, (_, index) => `- [g-${index}](g-${index}.md) — ${"g".repeat(90)}`).join("\n")

    // When the combined block is rendered
    const block = buildSystemBlock(indexes(project, global))
    const projectCount = block.split("\n").filter((line) => line.startsWith("- [p-")).length
    const globalCount = block.split("\n").filter((line) => line.startsWith("- [g-")).length

    // Then bytes are bounded and retained pointer capacity follows the requested split
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(MEMORY_BLOCK_MAX_BYTES)
    expect(projectCount / (projectCount + globalCount)).toBeGreaterThanOrEqual(0.55)
    expect(projectCount / (projectCount + globalCount)).toBeLessThanOrEqual(0.65)
  })

  test("spills unused project capacity into global pointers", () => {
    // Given a small project index and an oversized global index
    const project = Array.from({ length: 2 }, (_, index) => `- [p-${index}](p-${index}.md) — project`).join("\n")
    const global = Array.from({ length: 100 }, (_, index) => `- [g-${index}](g-${index}.md) — global`).join("\n")

    // When the combined block is rendered
    const block = buildSystemBlock(indexes(project, global))
    const globalCount = block.split("\n").filter((line) => line.startsWith("- [g-")).length

    // Then global receives more than its initial 40% line share
    expect(globalCount).toBeGreaterThan(32)
  })

  test("empty indexes omit code fences", () => {
    expect(buildSystemBlock({ project: EMPTY_INDEX, global: EMPTY_INDEX })).not.toContain("```")
  })
})

describe("injectInto", () => {
  test("appends one combined block without changing existing entries", () => {
    const system: string[] = ["base prompt"]
    injectInto(system, indexes("- [a](a.md) — project", "- [b](b.md) — global"))
    expect(system[0]).toBe("base prompt")
    expect(system[1]?.split("\n", 1)[0]).toBe(MEMORY_BLOCK_SENTINEL)
  })

  test("deduplicates only an entry whose first line exactly equals the sentinel", () => {
    // Given an unrelated entry with a similar prefix
    const system: string[] = [`${MEMORY_BLOCK_SENTINEL} unrelated`]

    // When injection runs twice against the same mutable array
    injectInto(system, indexes("- [a](a.md) — project", ""))
    injectInto(system, indexes("- [a](a.md) — project", ""))

    // Then exactly one exact-sentinel block was appended
    expect(system.filter((entry) => entry.split("\n", 1)[0] === MEMORY_BLOCK_SENTINEL).length).toBe(1)
    expect(system.length).toBe(2)
  })
})
