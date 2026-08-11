import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseMemory } from "../src/frontmatter"
import { PathContainmentError, SecretDetectedError, createStore } from "../src/store"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("store.save", () => {
  test("writes the topic file AND an index pointer", async () => {
    // When a memory is saved
    const out = await createStore(dir).save({ type: "user", slug: "user-role", description: "data scientist", body: "The user focuses on logging quality." })
    // Then the topic file carries the type and the index gains a pointer
    expect(out.created).toBe(true)
    expect(await readFile(join(dir, "user-role.md"), "utf8")).toContain("type: user")
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toContain("](user-role.md)")
  })

  test("updating the same slug does not duplicate the pointer", async () => {
    const store = createStore(dir)
    await store.save({ type: "feedback", slug: "pr-style", description: "one bundled PR", body: "Bundle related changes into one pull request." })
    const out = await store.save({ type: "feedback", slug: "pr-style", description: "one bundled PR v2", body: "Bundle the complete change into one pull request." })
    const index = await readFile(join(dir, "MEMORY.md"), "utf8")
    expect(out.created).toBe(false)
    expect(index.split("\n").filter((l) => l.includes("](pr-style.md)")).length).toBe(1)
    expect(index).toContain("v2")
  })

  test("rejects a traversal slug", async () => {
    await expect(
      createStore(dir).save({ type: "user", slug: "../evil", description: "unsafe traversal", body: "This body is long enough to reach slug validation." }),
    ).rejects.toBeInstanceOf(PathContainmentError)
  })

  test("hard-blocks content that looks like a secret", async () => {
    await expect(
      createStore(dir).save({ type: "reference", slug: "creds", description: "credential pointer", body: "AKIAIOSFODNN7EXAMPLE" }),
    ).rejects.toBeInstanceOf(SecretDetectedError)
  })

  test("concurrent saves both land without losing a pointer", async () => {
    const store = createStore(dir)
    await Promise.all([
      store.save({ type: "user", slug: "aaa", description: "one", body: "The first durable memory body is sufficiently detailed." }),
      store.save({ type: "user", slug: "bbb", description: "two", body: "The second durable memory body is sufficiently detailed." }),
    ])
    const index = await readFile(join(dir, "MEMORY.md"), "utf8")
    expect(index).toContain("](aaa.md)")
    expect(index).toContain("](bbb.md)")
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    expect(files.sort()).toEqual(["aaa.md", "bbb.md"])
  })

  test("concurrent saves for the same slug keep topic and pointer from one writer", async () => {
    // Given two distinct updates for one slug
    const store = createStore(dir)
    const first = { type: "feedback", slug: "shared", description: "writer one", body: "The first writer provides this durable memory body." } as const
    const second = { type: "feedback", slug: "shared", description: "writer two", body: "The second writer provides another durable memory body." } as const

    // When both updates run concurrently
    await Promise.all([store.save(first), store.save(second)])

    // Then the final topic description and index description belong to the same writer
    const topic = parseMemory(await readFile(join(dir, "shared.md"), "utf8"))
    const index = await readFile(join(dir, "MEMORY.md"), "utf8")
    expect(topic.frontmatter.description === first.description || topic.frontmatter.description === second.description).toBe(true)
    expect(index).toContain(`— ${topic.frontmatter.description}`)
  })
})

describe("store.readIndexForInjection", () => {
  test("is empty when no store exists", async () => {
    expect(await createStore(dir).readIndexForInjection()).toEqual({ content: "", truncated: false })
  })

  test("flags truncation and caps at 200 lines", async () => {
    const lines = Array.from({ length: 205 }, (_, i) => `- [s${i}](s${i}.md) — d${i}`).join("\n")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "MEMORY.md"), `${lines}\n`, "utf8")
    const idx = await createStore(dir).readIndexForInjection()
    expect(idx.truncated).toBe(true)
    expect(idx.content.split("\n").filter((l) => l.length > 0).length).toBeLessThanOrEqual(200)
  })

  test("retains newest pointers and renders them newest-first when line-capped", async () => {
    // Given an oldest-to-newest index beyond the line cap
    const lines = Array.from({ length: 205 }, (_, index) => `- [s${index}](s${index}.md) — d${index}`).join("\n")
    await writeFile(join(dir, "MEMORY.md"), `${lines}\n`, "utf8")

    // When the index is prepared for injection
    const index = await createStore(dir).readIndexForInjection()
    const retained = index.content.split("\n").filter((line) => line.length > 0)

    // Then the newest pointer leads and the five oldest pointers are evicted
    expect(retained[0]).toContain("](s204.md)")
    expect(retained.at(-1)).toContain("](s5.md)")
    expect(index.content).not.toContain("](s0.md)")
  })

  test("retains newest pointers from an index beyond the hard read cap", async () => {
    // Given an oldest-to-newest sparse index beyond the runtime full-file buffer ceiling
    const path = join(dir, "MEMORY.md")
    const sparseBytes = 8 * 1024 * 1024 * 1024
    const newest = "\n- [hard-4998](hard-4998.md) — description 4998\n- [hard-4999](hard-4999.md) — description 4999\n"
    const handle = await open(path, "w")
    await handle.write("- [hard-0](hard-0.md) — description 0\n", 0, "utf8")
    await handle.truncate(sparseBytes)
    await handle.write(newest, sparseBytes - Buffer.byteLength(newest), "utf8")
    await handle.close()

    // When the index is prepared for injection
    const index = await createStore(dir).readIndexForInjection()

    // Then truncation is reported and the newest tail pointers are retained
    expect(index.truncated).toBe(true)
    expect(index.content.split("\n")[0]).toContain("](hard-4999.md)")
    expect(index.content).not.toContain("](hard-0.md)")
  })
})
