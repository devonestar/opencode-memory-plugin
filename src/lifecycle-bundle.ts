import { mkdir, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { LifecycleFault } from "./lifecycle-checkpoints"
import { materializePrivateBytesExclusive, publishPrivateDirectoryExclusive } from "./private-file-move"
import { ensurePrivateDir } from "./private-fs"

export type StagedBundleFile = {
  readonly name: string
  readonly bytes: Uint8Array
  readonly checkpoint: LifecycleCheckpointName
}

type LifecycleCheckpointName = Parameters<LifecycleFault>[0]["phase"]

export async function stageAndPublishBundle(input: {
  readonly storeRoot: string
  readonly stagingRoot: string
  readonly destinationRoot: string
  readonly files: readonly StagedBundleFile[]
  readonly publishedCheckpoint: LifecycleCheckpointName
  readonly fault?: LifecycleFault
}): Promise<void> {
  const parent = await ensurePrivateDir(input.storeRoot, dirname(input.stagingRoot))
  const staging = join(parent, basename(input.stagingRoot))
  try {
    await mkdir(staging, { mode: 0o700 })
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new BundleCollisionError(staging)
    throw error
  }
  for (const file of input.files) {
    const created = await materializePrivateBytesExclusive(input.storeRoot, join(staging, file.name), file.bytes)
    if (!created) throw new BundleCollisionError(join(staging, file.name))
    await input.fault?.({ phase: file.checkpoint })
  }
  if (!(await publishPrivateDirectoryExclusive(input.storeRoot, staging, input.destinationRoot))) {
    throw new BundleCollisionError(input.destinationRoot)
  }
  await input.fault?.({ phase: input.publishedCheckpoint })
}

export async function removeStagedBundle(storeRoot: string, path: string): Promise<void> {
  const parent = await ensurePrivateDir(storeRoot, dirname(path))
  await rm(join(parent, basename(path)), { recursive: true, force: true })
}

export class BundleCollisionError extends Error {
  readonly name = "BundleCollisionError"
  constructor(readonly path: string) { super(`lifecycle bundle collision: ${path}`) }
}
