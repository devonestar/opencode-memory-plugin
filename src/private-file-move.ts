import { randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { chmod, link, lstat, open, rename, rm, stat, type FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { ensurePrivateDir, PrivatePathError } from "./private-fs"

async function privateDestination(trustedRoot: string, path: string): Promise<string> {
  const parent = await ensurePrivateDir(trustedRoot, dirname(path))
  return join(parent, basename(path))
}

async function rejectNonRegularDestination(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new PrivatePathError(path, "destination is not a regular file")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

export async function replacePrivateBytesAtomic(trustedRoot: string, path: string, bytes: Uint8Array): Promise<void> {
  const destination = await privateDestination(trustedRoot, path)
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`
  try {
    const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
    try {
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
    await rejectNonRegularDestination(destination)
    await rename(temporary, destination)
    await chmod(destination, 0o600)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export type MaterializePrivateBytesOptions = {
  readonly onTemporaryReady?: (path: string) => Promise<void>
}

export async function materializePrivateBytesExclusive(
  trustedRoot: string,
  path: string,
  bytes: Uint8Array,
  options: MaterializePrivateBytesOptions = {},
): Promise<boolean> {
  const destination = await privateDestination(trustedRoot, path)
  const temporary = join(dirname(destination), `.${basename(destination)}.tmp-${process.pid}-${randomUUID()}`)
  let handle: FileHandle | undefined
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
    await handle.writeFile(bytes)
    await handle.chmod(0o600)
    await handle.sync()
    await handle.close()
    handle = undefined
    await options.onTemporaryReady?.(temporary)
    try {
      await link(temporary, destination)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false
      throw error
    }
    return true
  } finally {
    if (handle !== undefined) await handle.close()
    await rm(temporary, { force: true })
  }
}

export async function publishPrivateDirectoryExclusive(trustedRoot: string, stagedPath: string, destinationPath: string): Promise<boolean> {
  const stagedParent = await ensurePrivateDir(trustedRoot, dirname(stagedPath))
  const destinationParent = await ensurePrivateDir(trustedRoot, dirname(destinationPath))
  const staged = join(stagedParent, basename(stagedPath))
  const destination = join(destinationParent, basename(destinationPath))
  const stagedInfo = await lstat(staged)
  if (stagedInfo.isSymbolicLink() || !stagedInfo.isDirectory()) throw new PrivatePathError(staged, "staging source is not a directory")
  if ((await stat(stagedParent)).dev !== (await stat(destinationParent)).dev) throw new PrivatePathError(destination, "directory publish crosses filesystems")
  try {
    await lstat(destination)
    return false
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  }
  try {
    await rename(staged, destination)
    await chmod(destination, 0o700)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "ENOTEMPTY")) return false
    throw error
  }
}
