import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const DOCUMENT_PATH = join(import.meta.dir, "..", "docs", "architecture.html")
const NAV_ITEMS = [
  ["runtime-wiring", "01 · 저장소 / 런타임"],
  ["components", "02 · 내부 컴포넌트"],
  ["usecases", "03 · 유스케이스"],
  ["save-selection", "04 · 저장 후보 선정"],
  ["curation-decision", "05 · 큐레이션 판정"],
  ["sequences", "06 · 시퀀스 4개"],
] as const
const CONFIG_ASSETS = [
  "opencode/agent/memory-curator.md",
  "opencode/command/memory-review.md",
  "opencode/command/memory-curation-status.md",
  "opencode/command/memory-curation-run.md",
  "opencode/command/memory-curation-pause.md",
  "opencode/command/memory-curation-resume.md",
  "opencode/skills/memory-types/SKILL.md",
] as const
const PLUGIN_TOOLS = ["memory_save", "memory_curation_status", "memory_curation_run", "memory_curation_control"] as const

function sectionMarkup(document: string, id: string): string {
  const start = document.indexOf(`<section class="section" id="${id}"`)
  const end = document.indexOf('<section class="section"', start + 1)
  if (start < 0) return ""
  return document.slice(start, end < 0 ? document.length : end)
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1
}

describe("architecture document structure", () => {
  test("orders six navigation anchors before uniquely matching sections", async () => {
    // Given the offline architecture document
    const document = await readFile(DOCUMENT_PATH, "utf8")

    // When navigation and top-level section identifiers are read structurally
    const navItems = [...document.matchAll(/<a href="#([^"]+)">([^<]+)<\/a>/g)].map((match) => [match[1], match[2]])
    const sectionIds = [...document.matchAll(/<section class="section" id="([^"]+)"/g)].map((match) => match[1])

    // Then navigation order, unique targets, counters, and runtime-first placement match the six-section contract
    expect(navItems).toEqual(NAV_ITEMS.map(([id, label]) => [id, label]))
    expect(sectionIds).toEqual(NAV_ITEMS.map(([id]) => id))
    expect(new Set(sectionIds).size).toBe(sectionIds.length)
    expect(sectionMarkup(document, "runtime-wiring")).toContain('<h2 id="runtime-wiring-title">독립 저장소와 OpenCode 런타임 배선</h2>')
    expect([...document.matchAll(/class="section-number">(\d{2} \/ \d{2})</g)].map((match) => match[1])).toEqual([
      "01 / 06",
      "02 / 06",
      "03 / 06",
      "04 / 06",
      "05 / 06",
      "06 / 06",
    ])
    expect(document.indexOf('id="runtime-wiring"')).toBeLessThan(document.indexOf('id="components"'))
  })

  test("maps repository assets to runtime discovery exactly once", async () => {
    // Given the standalone repository wiring section
    const document = await readFile(DOCUMENT_PATH, "utf8")

    // When its source-to-runtime tree is isolated
    const wiring = sectionMarkup(document, "runtime-wiring")

    // Then all seven active config assets have one symlink mapping and no restore command exists
    expect(wiring.match(/data-wiring-stage="[a-d]"/g)).toHaveLength(4)
    expect(wiring.match(/data-config-asset=/g)).toHaveLength(7)
    for (const asset of CONFIG_ASSETS) expect(occurrences(wiring, asset)).toBe(1)
    expect(document).not.toContain("memory-curation-restore")
  })

  test("declares startup registrations without conflating tools and commands", async () => {
    // Given the runtime startup stage
    const wiring = sectionMarkup(await readFile(DOCUMENT_PATH, "utf8"), "runtime-wiring")

    // When machine-readable registration markers are inspected
    const toolNames = [...wiring.matchAll(/data-plugin-tool="([^"]+)"/g)].map((match) => match[1])

    // Then four tools, one hidden tool-free agent, five files, and one invokable skill yield six effective commands
    expect(toolNames).toEqual([...PLUGIN_TOOLS])
    expect(wiring.match(/data-agent="memory-curator" data-hidden="true" data-tools="none"/g)).toHaveLength(1)
    expect(wiring.match(/data-command-file=/g)).toHaveLength(5)
    expect(wiring.match(/data-skill="memory-types" data-invokable-command="\/memory-types"/g)).toHaveLength(1)
    expect(wiring).toContain('data-command-file-count="5" data-effective-command-count="6"')
    expect(wiring).toContain('data-restart-required="true"')
  })

  test("separates repository source of truth from external live data", async () => {
    // Given the repository, XDG, and live-memory boundaries
    const wiring = sectionMarkup(await readFile(DOCUMENT_PATH, "utf8"), "runtime-wiring")

    // When stable architecture identifiers and paths are read
    const dependencies = [...wiring.matchAll(/data-dependency="([^"]+)" data-version="([^"]+)"/g)].map((match) => [match[1], match[2]])

    // Then the pinned repository boundary and external runtime-data boundary remain explicit
    expect(dependencies).toEqual([
      ["@opencode-ai/plugin", "1.18.3"],
      ["@opencode-ai/sdk", "1.18.3"],
    ])
    expect(wiring).toContain("/Users/devvy/sandbox/opencode-memory-plugin/src/index.ts")
    expect(wiring).toContain("${XDG_CONFIG_HOME:-$HOME/.config}/opencode")
    expect(wiring).toContain("$HOME/.config/opencode")
    expect(wiring).toContain("file:///Users/devvy/sandbox/opencode-memory-plugin/src/index.ts")
    expect(wiring).toContain("${XDG_CONFIG_HOME:-$HOME/.config}/opencode/memory/")
    expect(wiring).toContain('data-boundary-role="repository-source"')
    expect(wiring).toContain('data-boundary-role="live-runtime-data"')
    expect(wiring.match(/data-flow-step="[1-4]"/g)).toHaveLength(4)
  })

  test("omits mutable runtime snapshots", async () => {
    // Given the complete architecture document
    const document = await readFile(DOCUMENT_PATH, "utf8")

    // When mutable snapshot patterns are checked
    const fixedRuntimeVersion = /OpenCode\s+v?\d+\.\d+\.\d+/
    const numericTestBadge = /\d+\s+(?:tests?|테스트)\s+(?:passing|통과)/i
    const concreteLocalNamespace = /local-[a-z0-9-]+-[a-f0-9]{8,}/

    // Then none are presented as permanent architecture
    expect(document).not.toMatch(fixedRuntimeVersion)
    expect(document).not.toMatch(numericTestBadge)
    expect(document).not.toMatch(concreteLocalNamespace)
  })
})
