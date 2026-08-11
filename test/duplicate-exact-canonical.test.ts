import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import { parseProposal, validateProposal } from "../src/proposal"
import { createTestStores, proposal, source, testSnapshot, writeTopic, type TestStores } from "./curation-fixture"

let dir: string
let stores: TestStores

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-curation-duplicate-canonical-"))
  stores = await createTestStores(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function validateDuplicate(input: {
  readonly secondRaw: string
  readonly sourceBody: string
  readonly description: string
}) {
  await writeTopic(stores, { scope: "global", slug: "first", description: input.description, body: input.sourceBody })
  await writeTopic(stores, { scope: "project", slug: "second", description: input.description, body: input.sourceBody })
  await writeFile(join(stores.project, "second.md"), input.secondRaw)
  const snapshot = await testSnapshot(stores)
  const operation = {
    id: "canonical-duplicate",
    kind: "MERGE",
    confidence: "high",
    reasonCode: "duplicate-exact",
    sources: [source(snapshot, "global", "first"), source(snapshot, "project", "second")],
    replacement: { scope: "global", slug: "first", type: "project", description: input.description, body: input.sourceBody },
  }
  return validateProposal(parseProposal(JSON.stringify(proposal(snapshot, [operation]))), snapshot, DEFAULT_CURATION_CONFIG)
}

describe("duplicate-exact parsed canonical equality", () => {
  test.each([
    ["surrounding body whitespace", (raw: string, body: string) => raw.replace(`\n${body}\n`, `\n  ${body}  \n`)],
    ["scalar frontmatter whitespace", (raw: string, _body: string, description: string) => raw.replace(`description: ${description}`, `description:   ${description}   `)],
    ["flat versus nested type representation", (raw: string) => raw.replace("metadata:\n  type: project\n", "type: project\n")],
  ] as const)("auto-merges %s", async (_name, transform) => {
    const description = "identical durable fact"
    const body = "The exact durable body appears in both memory scopes."
    const nested = `---\nname: second\ndescription: ${description}\nmetadata:\n  type: project\n---\n${body}\n`

    const result = await validateDuplicate({ secondRaw: transform(nested, body, description), sourceBody: body, description })

    expect(result.errors).toEqual([])
    expect(result.applicable.map((operation) => operation.id)).toEqual(["canonical-duplicate"])
  })

  test.each([
    ["internal body whitespace", "The exact durable body has  internal spacing."],
    ["body content", "The durable body has changed content."],
  ])("keeps %s non-applicable", async (_difference, changedBody) => {
    const description = "identical durable fact"
    const body = "The exact durable body appears in both memory scopes."
    const changed = `---\nname: second\ndescription: ${description}\nmetadata:\n  type: project\n---\n${changedBody}\n`

    const result = await validateDuplicate({ secondRaw: changed, sourceBody: body, description })

    expect(result.applicable).toEqual([])
    expect(result.errors.join(" ")).toContain("duplicate-exact")
  })
})
