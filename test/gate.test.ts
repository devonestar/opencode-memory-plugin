import { describe, expect, test } from "bun:test"
import { SaveGateError, validateSaveInput } from "../src/gate"

describe("memory save gate", () => {
  test("rejects a trivially short body with an actionable error", () => {
    expect(() => validateSaveInput({ slug: "brief", description: "short memory", body: "too short" })).toThrow(SaveGateError)
  })

  test("rejects a pointer that exceeds the store pointer limit", () => {
    expect(() =>
      validateSaveInput({
        slug: "long-pointer",
        description: "x".repeat(150),
        body: "This body is sufficiently detailed for durable memory.",
      }),
    ).toThrow(SaveGateError)
  })

  test("rejects an exact slug duplicate from the other scope", () => {
    expect(() =>
      validateSaveInput(
        { slug: "shared", description: "durable shared fact", body: "This body is sufficiently detailed for durable memory." },
        "global",
      ),
    ).toThrow(SaveGateError)
  })

  test.each(["first\nsecond", "first\rsecond", "first\0second", "escape ``` fence"]) (
    "rejects a description that can escape its physical index line: %p",
    (description) => {
      expect(() => validateSaveInput({ slug: "injected", description, body: "This durable body is sufficiently detailed for memory." })).toThrow(SaveGateError)
    },
  )
})
