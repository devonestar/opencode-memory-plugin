import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LockTimeoutError, withLock } from "../src/fsutil"

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-lock-")) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe("withLock", () => {
  test("a paused live PID holder is never stolen", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const options = { retryMs: 0, maxRetries: 2, sleep: async () => undefined, isProcessAlive: () => true }
    const first = withLock(join(dir, "live.lock"), async () => { entered.resolve(); await release.promise }, options)
    await entered.promise
    let secondEntered = false

    const second = withLock(join(dir, "live.lock"), async () => { secondEntered = true }, options)

    await expect(second).rejects.toBeInstanceOf(LockTimeoutError)
    expect(secondEntered).toBe(false)
    release.resolve()
    await first
  })

  test("reclaims a dead PID owner", async () => {
    const lockPath = join(dir, "dead.lock")
    await writeFile(lockPath, `${JSON.stringify({ token: "dead-token", pid: 424242 })}\n`)

    let entered = false
    await withLock(lockPath, async () => { entered = true }, { isProcessAlive: () => false, retryMs: 0, maxRetries: 2, sleep: async () => undefined })

    expect(entered).toBe(true)
    await expect(access(lockPath)).rejects.toBeDefined()
  })

  test("publishes complete lock metadata before a contender can observe the lock", async () => {
    const lockPath = join(dir, "publication.lock")
    const metadataReady = Promise.withResolvers<void>()
    const publish = Promise.withResolvers<void>()
    const observed: string[] = []
    const ownerOptions = {
      retryMs: 0,
      maxRetries: 2,
      sleep: async () => undefined,
      isProcessAlive: () => true,
      onMetadataPrepared: async () => {
        metadataReady.resolve()
        await publish.promise
      },
    }
    const owner = withLock(lockPath, async () => {
      observed.push(await readFile(lockPath, "utf8"))
    }, ownerOptions)
    await metadataReady.promise

    await withLock(lockPath, async () => {
      observed.push(await readFile(lockPath, "utf8"))
    }, { retryMs: 0, maxRetries: 1, sleep: async () => undefined, isProcessAlive: () => true })
    publish.resolve()
    await owner

    expect(observed).toHaveLength(2)
    for (const raw of observed) {
      expect(raw.length).toBeGreaterThan(0)
      expect(JSON.parse(raw)).toMatchObject({ pid: process.pid })
    }
  }, 1_000)

  test("a stale third contender cannot remove the live reclaimer", async () => {
    const lockPath = join(dir, "three-contender.lock")
    await writeFile(lockPath, `${JSON.stringify({ token: "dead-a", pid: 41 })}\n`)
    const staleObserved = Promise.withResolvers<void>()
    const releaseStale = Promise.withResolvers<void>()
    const liveEntered = Promise.withResolvers<void>()
    const releaseLive = Promise.withResolvers<void>()
    let liveCallbacks = 0
    let staleCallback = false
    const stale = withLock(lockPath, async () => { staleCallback = true }, {
      isProcessAlive: (pid) => pid === process.pid,
      retryMs: 0,
      maxRetries: 2,
      sleep: async () => undefined,
      onDeadOwnerObserved: async () => {
        staleObserved.resolve()
        await releaseStale.promise
      },
    })
    await staleObserved.promise
    const live = withLock(lockPath, async () => {
      liveCallbacks += 1
      liveEntered.resolve()
      await releaseLive.promise
    }, { isProcessAlive: () => false, retryMs: 0, maxRetries: 2, sleep: async () => undefined })
    await liveEntered.promise

    releaseStale.resolve()
    await expect(stale).rejects.toBeInstanceOf(LockTimeoutError)
    expect(staleCallback).toBe(false)
    expect(liveCallbacks).toBe(1)
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: process.pid })
    releaseLive.resolve()
    await live
  }, 1_000)

  test("does not delete a replacement lock during a quarantine race", async () => {
    const lockPath = join(dir, "race.lock")
    await writeFile(lockPath, `${JSON.stringify({ token: "observed", pid: 41 })}\n`)
    const replacement = { token: "replacement", pid: process.pid }

    await expect(withLock(lockPath, async () => undefined, {
      isProcessAlive: (pid) => pid === process.pid,
      retryMs: 0,
      maxRetries: 1,
      sleep: async () => undefined,
      onQuarantined: async () => { await writeFile(lockPath, `${JSON.stringify(replacement)}\n`) },
    })).rejects.toBeInstanceOf(LockTimeoutError)

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement)
  })
})
