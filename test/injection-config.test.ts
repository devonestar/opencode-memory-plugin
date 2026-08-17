import { describe, expect, test } from "bun:test"
import { DEFAULT_INJECTION_CONFIG, InjectionConfigError, parseInjectionOptions } from "../src/injection-config"

describe("injection configuration", () => {
  test("uses the historical hard-coded budgets when the plugin has no tuple options", () => {
    // Given a legacy non-tuple plugin declaration
    // When options are parsed
    const config = parseInjectionOptions(undefined)

    // Then the previously hard-coded prompt budgets are selected
    expect(config).toEqual(DEFAULT_INJECTION_CONFIG)
    expect(config).toEqual({ maxBlockBytes: 10_000, pointerBudgetBytes: 8_000, pointerMaxLines: 80, projectShare: 0.6 })
  })

  test("accepts a complete strict injection override", () => {
    // Given every supported option with a value different from its fallback
    const options = {
      injection: {
        maxBlockBytes: 6_000,
        pointerBudgetBytes: 4_000,
        pointerMaxLines: 40,
        projectShare: 0.7,
      },
    }

    // When options are parsed
    const config = parseInjectionOptions(options)

    // Then each explicit value wins over the default
    expect(config).toEqual(options.injection)
  })

  test("fills omitted keys with their defaults inside a partial override", () => {
    // Given a partial injection group
    const config = parseInjectionOptions({ injection: { pointerMaxLines: 20 } })

    // Then the explicit value wins and the rest stay at defaults
    expect(config.pointerMaxLines).toBe(20)
    expect(config.maxBlockBytes).toBe(DEFAULT_INJECTION_CONFIG.maxBlockBytes)
    expect(config.pointerBudgetBytes).toBe(DEFAULT_INJECTION_CONFIG.pointerBudgetBytes)
    expect(config.projectShare).toBe(DEFAULT_INJECTION_CONFIG.projectShare)
  })

  test("rejects unknown options rather than silently ignoring them", () => {
    // Given a misspelled option at the injection boundary
    const options = { injection: { pointerMaxLine: 40 } }

    // When and Then parsing occurs
    expect(() => parseInjectionOptions(options)).toThrow(InjectionConfigError)
  })

  test("rejects unknown top-level option groups", () => {
    expect(() => parseInjectionOptions({ injectionn: {} })).toThrow(InjectionConfigError)
  })

  test("tolerates a sibling curation group without validating it", () => {
    // Given a tuple carrying both option groups
    const config = parseInjectionOptions({ curation: { enabled: false }, injection: { maxBlockBytes: 5_000 } })

    // Then the injection group parses independently of curation
    expect(config.maxBlockBytes).toBe(5_000)
  })

  test.each([
    ["maxBlockBytes", 2_047],
    ["maxBlockBytes", 100_001],
    ["maxBlockBytes", 5_000.5],
    ["pointerBudgetBytes", 511],
    ["pointerBudgetBytes", 100_001],
    ["pointerMaxLines", 0],
    ["pointerMaxLines", 1_001],
    ["pointerMaxLines", 1.5],
    ["projectShare", 0.04],
    ["projectShare", 0.96],
  ])("rejects an invalid %s boundary: %p", (key, value) => {
    // Given one invalid bounded option
    const options = { injection: { [key]: value } }

    // When and Then parsing occurs
    expect(() => parseInjectionOptions(options)).toThrow(InjectionConfigError)
  })

  test.each([
    ["maxBlockBytes", 2_048],
    ["maxBlockBytes", 100_000],
    ["pointerBudgetBytes", 512],
    ["pointerMaxLines", 1],
    ["pointerMaxLines", 1_000],
    ["projectShare", 0.05],
    ["projectShare", 0.95],
  ])("accepts the %s boundary value %p", (key, value) => {
    const config = parseInjectionOptions({ injection: { [key]: value } })
    expect(config[key as keyof typeof config]).toBe(value as number)
  })
})
