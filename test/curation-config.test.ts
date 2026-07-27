import { describe, expect, test } from "bun:test"
import { DEFAULT_CURATION_CONFIG, CurationConfigError, parseCurationOptions } from "../src/curation-config"

describe("curation configuration", () => {
  test("uses production defaults when the plugin has no tuple options", () => {
    // Given a legacy non-tuple plugin declaration
    // When options are parsed
    const config = parseCurationOptions(undefined)

    // Then the bounded production defaults are selected
    expect(config).toEqual(DEFAULT_CURATION_CONFIG)
    expect(config.model).toBe("openai/gpt-5.6-sol")
  })

  test("accepts a complete strict curation override", () => {
    // Given every supported option with a value different from its fallback
    const options = {
      curation: {
        enabled: false,
        allowProviderEgress: true,
        model: "anthropic/claude-sonnet-4-6",
        maxAgeDays: 45,
        indexRatio: 0.8,
        changedTopics: 20,
        cooldownHours: 12,
        timeoutSeconds: 90,
        maxTopics: 100,
        maxTopicBytes: 16_384,
        maxInputBytes: 262_144,
        maxOutputBytes: 65_536,
        notify: false,
      },
    }

    // When options are parsed
    const config = parseCurationOptions(options)

    // Then each explicit value wins over the default
    expect(config).toEqual(options.curation)
  })

  test("rejects unknown options rather than silently ignoring them", () => {
    // Given a misspelled option at the curation boundary
    const options = { curation: { cooldownHour: 2 } }

    // When and Then parsing occurs
    expect(() => parseCurationOptions(options)).toThrow(CurationConfigError)
  })

  test.each([
    ["model", "missing-provider-prefix"],
    ["maxAgeDays", 0],
    ["indexRatio", 1.1],
    ["changedTopics", 0],
    ["cooldownHours", -1],
    ["timeoutSeconds", 0],
    ["maxTopics", 0],
    ["maxTopicBytes", 19],
    ["maxInputBytes", 99],
    ["maxOutputBytes", 99],
  ])("rejects an invalid %s boundary", (key, value) => {
    // Given one invalid bounded option
    const options = { curation: { [key]: value } }

    // When and Then parsing occurs
    expect(() => parseCurationOptions(options)).toThrow(CurationConfigError)
  })

  test.each([
    "opencode/big-pickle",
    "google/gemini-3",
    " openai/gpt-5.6-sol",
    "openai /gpt-5.6-sol",
    "openai/gpt-5.6-sol/extra",
    "openai\\gpt-5.6-sol",
  ])("rejects a model outside the exact provider allowlist: %s", (model) => {
    expect(() => parseCurationOptions({ curation: { model } })).toThrow(CurationConfigError)
  })

  test("disables provider egress by default", () => {
    expect(parseCurationOptions(undefined).allowProviderEgress).toBe(false)
  })
})
