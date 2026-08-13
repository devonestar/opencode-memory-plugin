import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLifecycleService } from "../src/lifecycle-service"
import { serializeMemory } from "../src/frontmatter"

const IDS = [
  "018f47a2-6d87-7d91-9f7e-6c0e40712a41",
  "018f47a2-73a0-7eb5-b820-59f79bd57f7b",
  "018f47a2-7a22-75c4-9033-71c741ca2620",
  "018f47a2-80d0-7d65-86c9-265944031f7f",
] as const

let root: string
let outside: string
let nextId: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-lifecycle-core-"))
  outside = await mkdtemp(join(tmpdir(), "memory-lifecycle-core-outside-"))
  nextId = 0
})

afterEach(async () => {
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
})

function service(scope: "global" | "project" = "project") {
  return createLifecycleService({
    storeRoot: root,
    scope,
    clock: () => new Date("2026-08-13T12:00:00.000Z"),
    createId: () => IDS[nextId++] ?? crypto.randomUUID(),
  })
}

async function topic(slug: string, body = "Exact durable body with trailing spaces.  \n"): Promise<Buffer> {
  const bytes = Buffer.from(serializeMemory({ name: slug, description: `${slug} description`, type: "project" }, body))
  await writeFile(join(root, `${slug}.md`), bytes)
  await writeFile(join(root, "MEMORY.md"), `- [${slug}](${slug}.md) — ${slug} description\n`, { flag: "a" })
  return bytes
}

describe("lifecycle service core", () => {
  test("archives exact topic bytes, excludes active, and builds the archive index", async () => {
    // Given an indexed active topic
    const original = await topic("alpha")

    // When the exact project store archives it
    const result = await service().archive({ scope: "project", slug: "alpha" })

    // Then the immutable archive and both derived indexes reflect the move
    expect(result.ok).toBe(true)
    expect(result.code).toBe("ARCHIVED")
    expect(result.ok ? String(result.entryId) : "").toBe(IDS[0])
    expect(Buffer.compare(await readFile(join(root, ".archive", "entries", IDS[0], "topic.md")), original)).toBe(0)
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toBe("")
    expect(await readFile(join(root, ".archive", "index.json"), "utf8")).toContain(IDS[0])
  })

  test("deletes to user trash without creating a searchable trash index", async () => {
    // Given an active topic
    await topic("discard")

    // When it is deleted
    const result = await service().delete({ scope: "project", slug: "discard" })

    // Then deletion means immutable trash and no trash index exists
    expect(result.ok).toBe(true)
    expect(result.code).toBe("TRASHED")
    expect(result.ok ? String(result.entryId) : "").toBe(IDS[0])
    await expect(access(join(root, ".user-trash", "entries", IDS[0], "topic.md"))).resolves.toBeNull()
    await expect(access(join(root, ".user-trash", "index.json"))).rejects.toBeDefined()
  })

  test("restores one exact archived entry while retaining its historical bytes", async () => {
    // Given an archived topic
    const original = await topic("alpha")
    const archived = await service().archive({ scope: "project", slug: "alpha" })
    if (!archived.ok) throw new TypeError("archive fixture failed")

    // When that exact source and entry are restored
    const restored = await service().restore({ scope: "project", source: "archive", entryId: archived.entryId })

    // Then exact active bytes return and the historical payload remains
    expect(restored).toEqual({ ok: true, code: "RESTORED", entryId: archived.entryId, slug: "alpha" })
    expect(Buffer.compare(await readFile(join(root, "alpha.md")), original)).toBe(0)
    expect(Buffer.compare(await readFile(join(root, ".archive", "entries", archived.entryId, "topic.md")), original)).toBe(0)
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toContain("](alpha.md)")
  })

  test("addresses multiple same-slug versions independently and rejects active collision", async () => {
    // Given two archived versions of one slug
    await topic("versioned", "First durable version.")
    const first = await service().archive({ scope: "project", slug: "versioned" })
    await topic("versioned", "Second durable version.")
    const second = await service().archive({ scope: "project", slug: "versioned" })
    if (!first.ok || !second.ok) throw new TypeError("archive fixtures failed")

    // When one exact version is restored and the other is retried
    const restored = await service().restore({ scope: "project", source: "archive", entryId: first.entryId })
    const collision = await service().restore({ scope: "project", source: "archive", entryId: second.entryId })

    // Then entry identity selects bytes and never overwrites the active slug
    expect(restored.code).toBe("RESTORED")
    expect(await readFile(join(root, "versioned.md"), "utf8")).toContain("First durable version.")
    expect(collision).toEqual({ ok: false, code: "ACTIVE_COLLISION" })
  })

  test("returns stable failures for missing, mismatched, and already-restored requests", async () => {
    // Given a missing topic and one archived project entry
    const missing = await service().archive({ scope: "project", slug: "missing" })
    await topic("alpha")
    const archived = await service().archive({ scope: "project", slug: "alpha" })
    if (!archived.ok) throw new TypeError("archive fixture failed")

    // When invalid exact requests and a restore retry are made
    const wrongScope = await service().restore({ scope: "global", source: "archive", entryId: archived.entryId })
    const wrongSource = await service().restore({ scope: "project", source: "trash", entryId: archived.entryId })
    const wrongId = await service().restore({ scope: "project", source: "archive", entryId: IDS[3] })
    const first = await service().restore({ scope: "project", source: "archive", entryId: archived.entryId })
    await rm(join(root, "alpha.md"))
    const retry = await service().restore({ scope: "project", source: "archive", entryId: archived.entryId })

    // Then public results expose only stable codes
    expect(missing).toEqual({ ok: false, code: "ACTIVE_NOT_FOUND" })
    expect(wrongScope).toEqual({ ok: false, code: "NOT_FOUND" })
    expect(wrongSource).toEqual({ ok: false, code: "NOT_FOUND" })
    expect(wrongId).toEqual({ ok: false, code: "NOT_FOUND" })
    expect(first.code).toBe("RESTORED")
    expect(retry).toEqual({ ok: false, code: "ALREADY_RESTORED" })
  })

  test("distinguishes missing restore entries from tampered canonical entries", async () => {
    // Given one archived entry whose canonical payload is tampered
    await topic("alpha")
    const archived = await service().archive({ scope: "project", slug: "alpha" })
    if (!archived.ok) throw new TypeError("archive fixture failed")

    // When missing and tampered entries are restored
    const missing = await service().restore({ scope: "project", source: "archive", entryId: IDS[3] })
    await writeFile(join(root, ".archive", "entries", archived.entryId, "topic.md"), "tampered")
    const tampered = await service().restore({ scope: "project", source: "archive", entryId: archived.entryId })

    // Then absence is not found while integrity failure blocks recovery without leaking details
    expect(missing).toEqual({ ok: false, code: "NOT_FOUND" })
    expect(tampered).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
  })

  test.each(["malformed", "symlink", "identity-mismatch"] as const)("classifies a %s active target as RECOVERY_BLOCKED without leaking a path", async (condition) => {
    // Given one requested active target whose persisted representation is unsafe
    const target = join(root, "unsafe.md")
    if (condition === "malformed") await writeFile(target, "not frontmatter")
    else if (condition === "symlink") await symlink(join(root, "missing-target.md"), target)
    else await writeFile(target, serializeMemory({ name: "other", description: "other description", type: "project" }, "Durable mismatched body."))

    // When archive inspects the exact active target
    const result = await service().archive({ scope: "project", slug: "unsafe" })

    // Then corruption is not reported as absence and no private path escapes
    expect(result).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
    expect(JSON.stringify(result)).not.toContain(root)
  })

  test("sanitizes an active symlink after existing derived indexes are accepted", async () => {
    // Given complete derived indexes and an active slug redirected to an external canary
    const canary = join(outside, "canary.md")
    await writeFile(canary, "EXTERNAL_CANARY")
    await symlink(canary, join(root, "unsafe.md"))
    await writeFile(join(root, "MEMORY.md"), "- [unsafe](unsafe.md) — unsafe description\n")
    await mkdir(join(root, ".archive"), { mode: 0o700 })
    await writeFile(join(root, ".archive", "index.json"), '{"version":1,"entries":[]}\n')

    // When archive reaches the exact active target check
    const result = await service().archive({ scope: "project", slug: "unsafe" })

    // Then the service returns a sanitized block and never touches the external target
    expect(result).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain(outside)
    expect(await readFile(canary, "utf8")).toBe("EXTERNAL_CANARY")
  })

  test("sanitizes a symlinked restore destination without touching its target", async () => {
    // Given an archived entry and its absent active destination replaced by an external symlink
    await topic("alpha")
    const archived = await service().archive({ scope: "project", slug: "alpha" })
    if (!archived.ok) throw new TypeError("archive fixture failed")
    const canary = join(outside, "canary.md")
    await writeFile(canary, "EXTERNAL_CANARY")
    await symlink(canary, join(root, "alpha.md"))

    // When restore checks its exact destination
    const result = await service().restore({ scope: "project", source: "archive", entryId: archived.entryId })

    // Then the service returns a sanitized block and preserves the external target
    expect(result).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain(outside)
    expect(await readFile(canary, "utf8")).toBe("EXTERNAL_CANARY")
  })
})
