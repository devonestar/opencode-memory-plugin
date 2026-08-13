import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLifecycleService, LifecycleCrashError, type LifecycleCheckpoint } from "../src/lifecycle-service"
import { recoverLifecycleStore } from "../src/lifecycle-recovery"
import { serializeMemory } from "../src/frontmatter"

const ENTRY_ID = "018f47a2-6d87-7d91-9f7e-6c0e40712a41"
const TRANSACTION_ID = "018f47a2-73a0-7eb5-b820-59f79bd57f7b"

let root: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-lifecycle-recovery-"))
  outside = await mkdtemp(join(tmpdir(), "memory-lifecycle-outside-"))
})

afterEach(async () => {
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
})

async function writeTopic(): Promise<Buffer> {
  const bytes = Buffer.from(serializeMemory({ name: "alpha", description: "alpha description", type: "project" }, "Durable recovery body."))
  await writeFile(join(root, "alpha.md"), bytes)
  await writeFile(join(root, "MEMORY.md"), "- [alpha](alpha.md) — alpha description\n")
  return bytes
}

function crashing(phase: LifecycleCheckpoint["phase"]) {
  let id = 0
  return createLifecycleService({
    storeRoot: root,
    scope: "project",
    clock: () => new Date("2026-08-13T12:00:00.000Z"),
    createId: () => [ENTRY_ID, TRANSACTION_ID][id++] ?? crypto.randomUUID(),
    fault: (checkpoint) => { if (checkpoint.phase === phase) throw new LifecycleCrashError(phase) },
  })
}

describe("lifecycle recovery core", () => {
  test("materializes an empty strict archive index during startup recovery", async () => {
    // Given an initialized store with no lifecycle transactions or archive entries

    // When startup recovery runs
    const recovered = await recoverLifecycleStore({ storeRoot: root, scope: "project" })

    // Then archive recall has a strict empty index to read
    expect(recovered).toEqual({ ok: true, code: "RECOVERED" })
    expect(JSON.parse(await readFile(join(root, ".archive", "index.json"), "utf8"))).toEqual({ version: 1, entries: [] })
  })

  test.each(["intent", "payload", "source", "receipt", "index"] as const)("fresh recovery converges after archive crash at %s", async (phase) => {
    // Given an archive interrupted at one persisted checkpoint
    const original = await writeTopic()
    await expect(crashing(phase).archive({ scope: "project", slug: "alpha" })).rejects.toBeInstanceOf(LifecycleCrashError)

    // When a fresh startup recovery reconciles the store
    const recovered = await recoverLifecycleStore({ storeRoot: root, scope: "project", clock: () => new Date("2026-08-13T12:01:00.000Z") })

    // Then every published transaction completes archive exactly
    expect(recovered.code).toBe("RECOVERED")
    await expect(access(join(root, "alpha.md"))).rejects.toBeDefined()
    expect(Buffer.compare(await readFile(join(root, ".archive", "entries", ENTRY_ID, "topic.md")), original)).toBe(0)
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toBe("")
  })

  test.each(["intent", "payload", "source", "receipt", "index"] as const)("mutation performs deterministic pre-recovery after crash at %s", async (phase) => {
    // Given an interrupted archive transaction
    await writeTopic()
    await expect(crashing(phase).archive({ scope: "project", slug: "alpha" })).rejects.toBeInstanceOf(LifecycleCrashError)

    // When a fresh service receives another mutation
    const result = await createLifecycleService({ storeRoot: root, scope: "project" }).delete({ scope: "project", slug: "missing" })

    // Then recovery ran before the requested mutation
    expect(result).toEqual({ ok: false, code: "ACTIVE_NOT_FOUND" })
    if (phase !== "intent") await expect(access(join(root, "alpha.md"))).rejects.toBeDefined()
  })

  test.each(["intent", "payload", "source", "receipt", "index"] as const)("fresh recovery converges after restore crash at %s", async (phase) => {
    // Given an archived entry and a restore interrupted at one checkpoint
    const original = await writeTopic()
    const archived = await createLifecycleService({ storeRoot: root, scope: "project" }).archive({ scope: "project", slug: "alpha" })
    if (!archived.ok) throw new TypeError("archive fixture failed")
    const restoring = createLifecycleService({
      storeRoot: root,
      scope: "project",
      createId: () => TRANSACTION_ID,
      fault: (checkpoint) => { if (checkpoint.phase === phase) throw new LifecycleCrashError(phase) },
    })
    await expect(restoring.restore({ scope: "project", source: "archive", entryId: archived.entryId })).rejects.toBeInstanceOf(LifecycleCrashError)

    // When a fresh startup recovery reconciles the store
    const recovered = await recoverLifecycleStore({ storeRoot: root, scope: "project" })

    // Then exact active bytes and restored receipt state converge
    expect(recovered.code).toBe("RECOVERED")
    expect(Buffer.compare(await readFile(join(root, "alpha.md")), original)).toBe(0)
    const receipt = JSON.parse(await readFile(join(root, ".archive", "entries", archived.entryId, "state.json"), "utf8")) as { readonly state?: unknown }
    expect(receipt.state).toBe("restored")
  })

  test("fresh recovery rebuilds both indexes after restore receipt crash and remains idempotent", async () => {
    // Given an archived entry whose restore crashed after its restored receipt but before index rebuild
    await writeTopic()
    const archived = await createLifecycleService({ storeRoot: root, scope: "project" }).archive({ scope: "project", slug: "alpha" })
    if (!archived.ok) throw new TypeError("archive fixture failed")
    const restoring = createLifecycleService({
      storeRoot: root,
      scope: "project",
      createId: () => crypto.randomUUID(),
      fault: (checkpoint) => { if (checkpoint.phase === "receipt") throw new LifecycleCrashError("receipt") },
    })
    await expect(restoring.restore({ scope: "project", source: "archive", entryId: archived.entryId })).rejects.toBeInstanceOf(LifecycleCrashError)
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toBe("")
    expect(await readFile(join(root, ".archive", "index.json"), "utf8")).toContain(String(archived.entryId))

    // When fresh startup recovery runs twice
    const first = await recoverLifecycleStore({ storeRoot: root, scope: "project" })
    const activeIndex = await readFile(join(root, "MEMORY.md"), "utf8")
    const archiveIndex = await readFile(join(root, ".archive", "index.json"), "utf8")
    const second = await recoverLifecycleStore({ storeRoot: root, scope: "project" })

    // Then active injection includes the restored topic, archive search excludes it, and rerun is byte-stable
    expect(first).toEqual({ ok: true, code: "RECOVERED" })
    expect(activeIndex).toBe("- [alpha](alpha.md) — alpha description\n")
    expect(JSON.parse(archiveIndex)).toEqual({ version: 1, entries: [] })
    expect(second).toEqual({ ok: true, code: "RECOVERED" })
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toBe(activeIndex)
    expect(await readFile(join(root, ".archive", "index.json"), "utf8")).toBe(archiveIndex)
  })

  test("blocks tampered payload recovery without guessing", async () => {
    // Given a crash with an immutable payload that is later tampered
    await writeTopic()
    await expect(crashing("payload").archive({ scope: "project", slug: "alpha" })).rejects.toBeInstanceOf(LifecycleCrashError)
    await writeFile(join(root, ".archive", "entries", ENTRY_ID, "topic.md"), "tampered")

    // When startup recovery inspects hashes
    const recovered = await recoverLifecycleStore({ storeRoot: root, scope: "project" })

    // Then recovery blocks and leaves the active source untouched
    expect(recovered).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
    await expect(access(join(root, "alpha.md"))).resolves.toBeNull()
  })

  test("blocks symlinked lifecycle namespaces before mutation", async () => {
    // Given an archive namespace redirected outside the store
    await writeTopic()
    await symlink(outside, join(root, ".archive"))

    // When archive is requested
    const result = await createLifecycleService({ storeRoot: root, scope: "project" }).archive({ scope: "project", slug: "alpha" })

    // Then the request is blocked and no outside artifact appears
    expect(result).toEqual({ ok: false, code: "RECOVERY_BLOCKED" })
    expect(await readFile(join(root, "alpha.md"), "utf8")).toContain("Durable recovery body.")
    await expect(access(join(outside, "entries"))).rejects.toBeDefined()
  })
})
