import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CURATION_CONFIG } from "../src/curation-config"
import { serializeMemory } from "../src/frontmatter"
import { captureSnapshot } from "../src/snapshot"

let dir: string

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

describe("memory snapshot trust boundary", () => {
  test("rejects a group or world writable store before any snapshot dispatch", async () => {
    dir = await mkdtemp(join(tmpdir(), "mem-trust-writable-"))
    const stores = await makeStores(dir)
    await writeTopic(stores.global, "unsafe-root")
    await chmod(stores.global, 0o777)

    let dispatches = 0

    await expect(captureSnapshot(stores, DEFAULT_CURATION_CONFIG, async () => {
      dispatches += 1
    })).rejects.toThrow("permissions")

    expect(dispatches).toBe(0)
  })

  test("accepts owner-private stores", async () => {
    dir = await mkdtemp(join(tmpdir(), "mem-trust-private-"))
    const stores = await makeStores(dir)
    await writeTopic(stores.global, "trusted-root")

    const snapshot = await captureSnapshot(stores, DEFAULT_CURATION_CONFIG)

    expect(snapshot.topics.map((topic) => `${topic.scope}:${topic.slug}`)).toEqual(["global:trusted-root"])
  })

  test("rejects a parent inode change after descriptor-bound reads", async () => {
    dir = await mkdtemp(join(tmpdir(), "mem-trust-inode-"))
    const stores = await makeStores(dir)
    await writeTopic(stores.global, "racy-root")

    let dispatches = 0

    await expect(
      captureSnapshot(stores, DEFAULT_CURATION_CONFIG, async (checkpoint) => {
        dispatches += 1
        if (checkpoint.phase !== "after-descriptor-reads") return
        await rm(stores.global, { recursive: true, force: true })
        await mkdir(stores.global, { mode: 0o700 })
      }),
    ).rejects.toThrow("trusted directory changed during snapshot")

    expect(dispatches).toBeGreaterThan(0)
  })

  test("rejects a static parent symlink before snapshot dispatch", async () => {
    dir = await mkdtemp(join(tmpdir(), "mem-trust-symlink-"))
    const target = join(dir, "target")
    const linked = join(dir, "global")
    const stores = { global: linked, project: join(dir, "project") }
    await Promise.all([mkdir(target, { mode: 0o700 }), mkdir(stores.project, { recursive: true, mode: 0o700 })])
    await symlink(target, linked)
    await writeTopic(target, "linked-root")

    let dispatches = 0

    await expect(captureSnapshot(stores, DEFAULT_CURATION_CONFIG, async () => {
      dispatches += 1
    })).rejects.toThrow("symlink")

    expect(dispatches).toBe(0)
  })
})

type TestStores = { readonly global: string; readonly project: string }

async function makeStores(root: string): Promise<TestStores> {
  const stores = { global: join(root, "global"), project: join(root, "project") }
  await Promise.all([mkdir(stores.global, { recursive: true, mode: 0o700 }), mkdir(stores.project, { recursive: true, mode: 0o700 })])
  return stores
}

async function writeTopic(storeDir: string, slug: string): Promise<void> {
  const raw = serializeMemory(
    { name: slug, description: `${slug} description`, type: "project" },
    `The durable memory body for ${slug}.`,
  )
  await writeFile(join(storeDir, `${slug}.md`), raw)
}
