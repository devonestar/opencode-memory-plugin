import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readRegularFilePrefix } from "../src/private-fs"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-bounded-fs-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("bounded regular file reads", () => {
  test("reads only limit plus one bytes from a large sparse file", async () => {
    // Given a sparse regular file much larger than the requested prefix
    const path = join(dir, "large.md")
    const sparseBytes = 8 * 1024 * 1024 * 1024
    const handle = await open(path, "w")
    await handle.truncate(sparseBytes)
    await handle.close()

    // When the bounded prefix is read
    const file = await readRegularFilePrefix(path, 32 * 1024)

    // Then only the oversize sentinel byte is returned
    expect(file.bytes.length).toBe(32 * 1024 + 1)
    expect(file.info.size).toBe(sparseBytes)
  })

  test("rejects a FIFO without waiting for a writer", async () => {
    // Given a FIFO with no reader or writer attached
    const path = join(dir, "topic.md")
    const mkfifo = Bun.spawn(["mkfifo", path], { stderr: "pipe", stdout: "pipe" })
    expect(await mkfifo.exited).toBe(0)
    const probe = Bun.spawn([
      "bun",
      "-e",
      `import { PrivatePathError, readRegularFilePrefix } from "./src/private-fs.ts";
try {
  await readRegularFilePrefix(${JSON.stringify(path)}, 32);
  process.exit(2);
} catch (error) {
  process.exit(error instanceof PrivatePathError ? 0 : 3);
}`,
    ], { cwd: join(import.meta.dir, ".."), stderr: "pipe", stdout: "pipe" })
    const timeout = setTimeout(() => probe.kill(), 1_000)

    // When the bounded reader opens the FIFO
    const exitCode = await probe.exited
    clearTimeout(timeout)

    // Then it rejects the target before the deadline instead of blocking on open
    expect(exitCode).toBe(0)
  })
})
