import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-process-restart-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function phase(name: "dispatch" | "recover"): Promise<Record<string, unknown>> {
  const process = Bun.spawn(["bun", "test/process-restart-probe.ts", name, dir], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (exitCode !== 0) throw new TypeError(`restart probe ${name} failed: ${stderr}`)
  return JSON.parse(stdout) as Record<string, unknown>
}

describe("isolated process restart", () => {
  test("a child dispatched in one process finalizes from persisted snapshot in another", async () => {
    const dispatched = await phase("dispatch")
    expect(dispatched["accepted"]).toBe(true)

    const recovered = await phase("recover")

    expect(recovered["active"]).toBeUndefined()
    expect(recovered["lastResult"]).toHaveProperty("status", "no-op")
  })
})
