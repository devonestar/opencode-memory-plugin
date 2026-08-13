import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { materializePrivateBytesExclusive, publishPrivateDirectoryExclusive, replacePrivateBytesAtomic } from "../src/private-file-move"
import { ensurePrivateRoot } from "../src/private-fs"

let root: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-private-bytes-"))
  outside = await mkdtemp(join(tmpdir(), "memory-private-outside-"))
  await ensurePrivateRoot(root)
})

afterEach(async () => {
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
})

describe("private exact-byte files", () => {
  test("atomically preserves arbitrary Uint8Array bytes with private permissions", async () => {
    // Given bytes that are not valid UTF-8 text
    const bytes = Uint8Array.from([0, 255, 128, 10, 13, 0, 42])
    const destination = join(root, "nested", "payload.bin")

    // When they are written through the private atomic primitive
    await replacePrivateBytesAtomic(root, destination, bytes)

    // Then no encoding occurs and owner-only modes are enforced
    expect(await readFile(destination)).toEqual(Buffer.from(bytes))
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, "nested"))).mode & 0o777).toBe(0o700)
  })

  test("materializes exact bytes exclusively without replacing a destination", async () => {
    // Given an existing private destination
    const destination = join(root, "entry", "record.bin")
    const firstCreated = await materializePrivateBytesExclusive(root, destination, Uint8Array.from([1, 2, 3]))

    // When a second payload targets the same path
    const created = await materializePrivateBytesExclusive(root, destination, Uint8Array.from([9, 8, 7]))

    // Then the collision is reported and original bytes remain
    expect(firstCreated).toBe(true)
    expect(created).toBe(false)
    expect(await readFile(destination)).toEqual(Buffer.from([1, 2, 3]))
  })

  test("keeps the canonical path absent until complete publication", async () => {
    // Given bytes and a callback at the fully written temporary-file boundary
    const bytes = Uint8Array.from([0, 255, 128, 10])
    const destination = join(root, "publication", "record.bin")
    let temporary: string | undefined

    // When publication is paused after syncing and closing the temporary file
    const created = await materializePrivateBytesExclusive(root, destination, bytes, {
      onTemporaryReady: async (path) => {
        temporary = path
        await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" })
        expect(await readFile(path)).toEqual(Buffer.from(bytes))
        expect((await stat(path)).mode & 0o777).toBe(0o600)
      },
    })

    // Then the canonical file appears only after the callback returns
    expect(created).toBe(true)
    expect(temporary).toBeDefined()
    expect(await readFile(destination)).toEqual(Buffer.from(bytes))
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
  })

  test("removes canonical and staging debris when publication fails before linking", async () => {
    // Given a callback that fails before the temporary file can be published
    const destination = join(root, "failed", "record.bin")

    // When materialization fails after the exact temporary bytes are prepared
    await expect(materializePrivateBytesExclusive(root, destination, Uint8Array.from([6, 7, 8]), {
      onTemporaryReady: async () => {
        throw new Error("publication interrupted")
      },
    })).rejects.toThrow("publication interrupted")

    // Then neither the canonical file nor its temporary staging file remains
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readdir(join(root, "failed"))).toEqual([])
  })

  test("never replaces a winner that publishes during the staging window", async () => {
    // Given a competing publisher that wins before this file links
    const destination = join(root, "race", "record.bin")

    // When the competing winner is created from the publication callback
    const created = await materializePrivateBytesExclusive(root, destination, Uint8Array.from([1, 2, 3]), {
      onTemporaryReady: async () => {
        await writeFile(destination, Buffer.from([9, 8, 7]), { mode: 0o600 })
      },
    })

    // Then this publisher reports the race and preserves the winner's bytes
    expect(created).toBe(false)
    expect(await readFile(destination)).toEqual(Buffer.from([9, 8, 7]))
  })

  test("atomic replacement is explicit and preserves exact replacement bytes", async () => {
    // Given a mutable private destination
    const destination = join(root, "receipts", "latest.bin")
    await replacePrivateBytesAtomic(root, destination, Uint8Array.from([1, 2, 3]))

    // When the explicit replacement primitive writes new bytes
    await replacePrivateBytesAtomic(root, destination, Uint8Array.from([9, 8, 7]))

    // Then the destination contains only the replacement bytes
    expect(await readFile(destination)).toEqual(Buffer.from([9, 8, 7]))
  })

  test("rejects a symlinked namespace without changing the outside path", async () => {
    // Given a lifecycle namespace redirected outside the trusted store
    const outsideFile = join(outside, "record.bin")
    await writeFile(outsideFile, Buffer.from([4, 5, 6]))
    await symlink(outside, join(root, ".archive"))

    // When an exact payload is written through the namespace
    await expect(materializePrivateBytesExclusive(root, join(root, ".archive", "record.bin"), Uint8Array.from([7, 8, 9]))).rejects.toThrow("symlink")

    // Then the outside file and namespace link are unchanged
    expect(await readFile(outsideFile)).toEqual(Buffer.from([4, 5, 6]))
    expect((await lstat(join(root, ".archive"))).isSymbolicLink()).toBe(true)
  })

  test("publishes only a fully materialized staged directory and never replaces a canonical bundle", async () => {
    // Given one complete staged bundle and one existing canonical bundle
    const stage = join(root, "bundles", ".staging-first")
    const destination = join(root, "bundles", "canonical")
    await mkdir(stage, { recursive: true, mode: 0o700 })
    await writeFile(join(stage, "first.bin"), Buffer.from([1, 2, 3]), { mode: 0o600 })
    await writeFile(join(stage, "second.bin"), Buffer.from([4, 5, 6]), { mode: 0o600 })

    // When the staged directory is published and another stage targets the same destination
    const published = await publishPrivateDirectoryExclusive(root, stage, destination)
    const collisionStage = join(root, "bundles", ".staging-second")
    await mkdir(collisionStage, { mode: 0o700 })
    await writeFile(join(collisionStage, "first.bin"), Buffer.from([9]), { mode: 0o600 })
    const collision = await publishPrivateDirectoryExclusive(root, collisionStage, destination)

    // Then publication is one directory rename and collision preserves both sides
    expect(published).toBe(true)
    expect(collision).toBe(false)
    expect(await readFile(join(destination, "first.bin"))).toEqual(Buffer.from([1, 2, 3]))
    expect(await readFile(join(destination, "second.bin"))).toEqual(Buffer.from([4, 5, 6]))
    expect(await readFile(join(collisionStage, "first.bin"))).toEqual(Buffer.from([9]))
  })
})
