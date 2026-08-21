import { describe, expect, test } from "bun:test"
import { MEMORY_BLOCK_MAX_BYTES, MEMORY_BLOCK_SENTINEL, buildSystemBlock, injectInto, type InjectableSuggestion } from "../src/prompt"

const EMPTY_INDEX = { content: "", truncated: false } as const
const SUGGESTION: InjectableSuggestion = {
  kind: "REWRITE",
  reasonCode: "stale-detail",
  sourceSlugs: ["project:alpha", "global:beta", "project:gamma"],
  sourceCount: 5,
  destination: { scope: "project", slug: "current-detail" },
  locator: "0123456789ab",
}

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

  test("renders only bounded structural suggestion metadata", () => {
    // Given suggestion metadata with fields longer than their prompt limits
    const suggestion: InjectableSuggestion = {
      ...SUGGESTION,
      reasonCode: `reason-${"r".repeat(100)}`,
      sourceSlugs: ["project:alpha", "global:beta", "project:gamma", "global:filesystem-secret"],
      destination: { scope: "global", slug: `destination-${"d".repeat(100)}` },
      locator: "0123456789abcdef0123456789abcdef",
    }

    // When the memory block is rendered
    const block = buildSystemBlock({ project: EMPTY_INDEX, global: EMPTY_INDEX }, undefined, [suggestion])
    const line = block.split("\n").find((candidate) => candidate.startsWith("- kind="))

    // Then the machine-readable line carries only constrained metadata
    expect(line).toBeDefined()
    expect(line).toContain("kind=REWRITE")
    expect(line).toContain("source_count=5")
    expect(line).toContain("sources=project:alpha,global:beta")
    expect(line).not.toContain("project:gamma")
    expect(line).not.toContain("filesystem-secret")
    expect(line).not.toContain("0123456789abcdef")
    expect(Buffer.byteLength(line ?? "", "utf8")).toBeLessThanOrEqual(240)
  })

  test("trims pointers before suggestion lines to honor the whole-block byte cap", () => {
    // Given pointers that fill the configured block and three suggestions
    const pointers = Array.from({ length: 80 }, (_, index) => `- [p-${index}](p-${index}.md) — ${"p".repeat(80)}`).join("\n")
    const config = { maxBlockBytes: 2_048, pointerBudgetBytes: 8_000, pointerMaxLines: 80, projectShare: 0.6 }

    // When the bounded block is rendered
    const block = buildSystemBlock(indexes(pointers, pointers), config, [SUGGESTION, SUGGESTION, SUGGESTION])

    // Then pointer pressure is removed first and the final block remains bounded
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(config.maxBlockBytes)
    expect(block.split("\n").filter((line) => line.startsWith("- kind=")).length).toBe(3)
    expect(block.split("\n").filter((line) => line.startsWith("- [p-")).length).toBeLessThan(160)
  })

  test("renders three worst-case schema-valid suggestions within the minimum block budget without pointers", () => {
    // Given three suggestions at every persisted metadata maximum
    const maximal: InjectableSuggestion = {
      kind: "REWRITE",
      reasonCode: `r${"e".repeat(99)}`,
      sourceSlugs: Array.from({ length: 200 }, () => `project:${"s".repeat(100)}`),
      sourceCount: 200,
      destination: { scope: "project", slug: "d".repeat(100) },
      locator: "f".repeat(64),
    }
    const config = { maxBlockBytes: 2_048, pointerBudgetBytes: 512, pointerMaxLines: 1, projectShare: 0.6 }

    // When the pointer-free block is rendered at the supported minimum budget
    const truncatedEmptyIndex = { content: "", truncated: true } as const
    const block = buildSystemBlock({ project: truncatedEmptyIndex, global: truncatedEmptyIndex }, config, [maximal, maximal, maximal])
    const suggestionLines = block.split("\n").filter((line) => line.startsWith("- kind="))

    // Then all claimed suggestions fit and each source remains scope-qualified
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(2_048)
    expect(suggestionLines).toHaveLength(3)
    expect(suggestionLines.every((line) => line.includes("sources=project:"))).toBe(true)
    expect(block).not.toContain("- [")
  })
})

describe("buildSystemBlock with configured budgets", () => {
  const oversized = indexes(
    Array.from({ length: 200 }, (_, index) => `- [p-${index}](p-${index}.md) — ${"p".repeat(90)}`).join("\n"),
    Array.from({ length: 200 }, (_, index) => `- [g-${index}](g-${index}.md) — ${"g".repeat(90)}`).join("\n"),
  )

  test("defaults reproduce the historical block byte for byte", () => {
    // Given the default configuration passed explicitly
    const explicit = buildSystemBlock(oversized, { maxBlockBytes: 10_000, pointerBudgetBytes: 8_000, pointerMaxLines: 80, projectShare: 0.6 })

    // Then it matches the config-free call exactly
    expect(explicit).toBe(buildSystemBlock(oversized))
  })

  test("a smaller block cap bounds the rendered block", () => {
    // Given a halved block budget
    const config = { maxBlockBytes: 5_000, pointerBudgetBytes: 8_000, pointerMaxLines: 80, projectShare: 0.6 }

    // When the combined block is rendered
    const block = buildSystemBlock(oversized, config)

    // Then bytes are bounded by the configured cap, below the default
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(5_000)
  })

  test("a smaller line budget bounds retained pointers", () => {
    // Given a pointer line budget of 10
    const config = { maxBlockBytes: 10_000, pointerBudgetBytes: 8_000, pointerMaxLines: 10, projectShare: 0.6 }

    // When the combined block is rendered
    const block = buildSystemBlock(oversized, config)
    const pointerCount = block.split("\n").filter((line) => line.startsWith("- [")).length

    // Then at most 10 pointers survive
    expect(pointerCount).toBeLessThanOrEqual(10)
    expect(pointerCount).toBeGreaterThan(0)
  })

  test("a custom project share shifts the initial split", () => {
    // Given a project-heavy 90/10 share
    const config = { maxBlockBytes: 10_000, pointerBudgetBytes: 8_000, pointerMaxLines: 80, projectShare: 0.9 }

    // When the combined block is rendered
    const block = buildSystemBlock(oversized, config)
    const projectCount = block.split("\n").filter((line) => line.startsWith("- [p-")).length
    const globalCount = block.split("\n").filter((line) => line.startsWith("- [g-")).length

    // Then retained pointer capacity follows the requested split
    expect(projectCount / (projectCount + globalCount)).toBeGreaterThanOrEqual(0.85)
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
