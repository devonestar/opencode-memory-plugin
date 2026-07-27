import { describe, expect, test } from "bun:test"
import { MemoryParseError, isValidSlug, parseMemory, serializeMemory } from "../src/frontmatter"

describe("frontmatter", () => {
  test("serialize→parse round-trips with metadata.type nesting", () => {
    // Given a memory whose type lives under metadata (Claude-Code format)
    const fm = { name: "user-role", description: "data scientist, logging focus", type: "user" } as const
    // When serialized then parsed back
    const parsed = parseMemory(serializeMemory(fm, "prefers pnpm"))
    // Then the frontmatter and body survive the round-trip
    expect(parsed.frontmatter).toEqual(fm)
    expect(parsed.body).toBe("prefers pnpm")
  })

  test("serialized output nests type under metadata:", () => {
    const out = serializeMemory({ name: "x", description: "y", type: "feedback" }, "b")
    // Structural contract: type is nested, not top-level (drives CC-compatible parsing)
    expect(out).toContain("metadata:\n  type: feedback")
  })

  test("rejects content without a frontmatter block", () => {
    expect(() => parseMemory("just a body, no frontmatter")).toThrow(MemoryParseError)
  })

  test("rejects an invalid type value", () => {
    const raw = "---\nname: x\ndescription: y\nmetadata:\n  type: bogus\n---\nbody"
    expect(() => parseMemory(raw)).toThrow(MemoryParseError)
  })

  test("slug validation blocks path traversal and uppercase", () => {
    expect(isValidSlug("user-role")).toBe(true)
    expect(isValidSlug("../evil")).toBe(false)
    expect(isValidSlug("a/b")).toBe(false)
    expect(isValidSlug("..")).toBe(false)
    expect(isValidSlug("UPPER")).toBe(false)
    expect(isValidSlug("")).toBe(false)
  })
})
