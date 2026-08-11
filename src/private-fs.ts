import { randomUUID } from "node:crypto"
import { constants as fsConstants, type Stats } from "node:fs"
import { chmod, lstat, mkdir, open, realpath, rename, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export class PrivatePathError extends Error {
  readonly name = "PrivatePathError"
  constructor(readonly path: string, readonly detail: string) {
    super(`unsafe private path ${path}: ${detail}`)
  }
}

export type TrustedDirectoryIdentity = {
  readonly dev: number
  readonly ino: number
  readonly mode: number
  readonly realpath: string
  readonly uid: number | undefined
}

export type TrustedDirectory = {
  readonly path: string
  readonly identity: TrustedDirectoryIdentity
}

type RegularFileHandle = Awaited<ReturnType<typeof open>>

export type RegularFile = {
  readonly bytes: Buffer
  readonly info: Stats
}

export type BoundedRegularFile = RegularFile & {
  readonly truncated: boolean
}

async function withRegularFile<T>(path: string, work: (handle: RegularFileHandle, info: Stats) => Promise<T>): Promise<T> {
  let handle: RegularFileHandle
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") throw new PrivatePathError(path, "symlink")
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new PrivatePathError(path, "not a regular file")
    return await work(handle, info)
  } finally {
    await handle.close()
  }
}

async function readDescriptorRange(handle: RegularFileHandle, length: number, position: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  return bytes.subarray(0, offset)
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined
}

async function validateTrustedDirectory(path: string): Promise<TrustedDirectoryIdentity> {
  const linkInfo = await lstat(path)
  if (linkInfo.isSymbolicLink()) throw new PrivatePathError(path, "symlink")
  if (!linkInfo.isDirectory()) throw new PrivatePathError(path, "not a directory")

  const info = await stat(path)
  if (!info.isDirectory()) throw new PrivatePathError(path, "not a directory")
  const uid = currentUid()
  if (uid !== undefined && info.uid !== uid) throw new PrivatePathError(path, "wrong owner")
  if ((info.mode & 0o077) !== 0) throw new PrivatePathError(path, "permissions must be 0700")

  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode & 0o777,
    realpath: await realpath(path),
    uid,
  }
}

export async function captureTrustedDirectory(path: string): Promise<TrustedDirectory> {
  return { identity: await validateTrustedDirectory(path), path: await realpath(path) }
}

export async function verifyTrustedDirectory(trusted: TrustedDirectory): Promise<void> {
  const identity = await validateTrustedDirectory(trusted.path)
  if (
    identity.dev !== trusted.identity.dev ||
    identity.ino !== trusted.identity.ino ||
    identity.mode !== trusted.identity.mode ||
    identity.realpath !== trusted.identity.realpath ||
    identity.uid !== trusted.identity.uid
  ) {
    throw new PrivatePathError(trusted.path, "trusted directory changed during snapshot")
  }
}

async function canonicalPath(trustedRoot: string, path: string): Promise<string> {
  const rootInfo = await lstat(trustedRoot)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new PrivatePathError(trustedRoot, "trusted root is not a regular directory")
  await chmod(trustedRoot, 0o700)
  const root = await realpath(trustedRoot)
  const absolute = resolve(path)
  const lexicalRoot = resolve(trustedRoot)
  const lexicalChild = relative(lexicalRoot, absolute)
  const child = isContained(lexicalChild) ? lexicalChild : relative(root, absolute)
  if (!isContained(child)) throw new PrivatePathError(path, "escapes trusted root")
  const destination = resolve(root, child)
  let current = root
  for (const segment of child.split(sep).filter((value) => value.length > 0)) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new PrivatePathError(path, `symlink component: ${current}`)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") break
      throw error
    }
  }
  return destination
}

function isContained(child: string): boolean {
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

export async function ensurePrivateDir(trustedRoot: string, path: string): Promise<string> {
  const destination = await canonicalPath(trustedRoot, path)
  const root = await realpath(trustedRoot)
  const child = relative(root, destination)
  let current = root
  for (const segment of child.split(sep).filter((value) => value.length > 0)) {
    current = join(current, segment)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
    }
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new PrivatePathError(path, `non-directory component: ${current}`)
    await chmod(current, 0o700)
  }
  return destination
}

export async function ensurePrivateRoot(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  return canonicalPath(path, path)
}

export async function createPrivateDirExclusive(trustedRoot: string, path: string): Promise<boolean> {
  const parent = await ensurePrivateDir(trustedRoot, dirname(path))
  const destination = join(parent, basename(path))
  try {
    await mkdir(destination, { mode: 0o700 })
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false
    throw error
  }
}

export async function writePrivate(trustedRoot: string, path: string, content: string): Promise<void> {
  const destination = await canonicalPath(trustedRoot, path)
  await ensurePrivateDir(trustedRoot, dirname(destination))
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(content, "utf8")
  } finally {
    await handle.close()
  }
  await canonicalPath(trustedRoot, destination)
  try {
    const current = await lstat(destination)
    if (current.isSymbolicLink() || !current.isFile()) throw new PrivatePathError(destination, "destination is not a regular file")
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  }
  await rename(temporary, destination)
  await chmod(destination, 0o600)
}

export async function writePrivateExclusive(trustedRoot: string, path: string, content: string): Promise<boolean> {
  const destination = await canonicalPath(trustedRoot, path)
  await ensurePrivateDir(trustedRoot, dirname(destination))
  try {
    const handle = await open(destination, "wx", 0o600)
    try {
      await handle.writeFile(content, "utf8")
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false
    throw error
  }
}

export async function readPrivate(trustedRoot: string, path: string): Promise<string> {
  return (await readPrivateBytes(trustedRoot, path)).bytes.toString("utf8")
}

export async function readRegularFile(path: string): Promise<RegularFile> {
  return withRegularFile(path, async (handle, info) => ({ bytes: await handle.readFile(), info }))
}

export async function readRegularFilePrefix(path: string, limit: number): Promise<RegularFile> {
  return withRegularFile(path, async (handle, info) => ({ bytes: await readDescriptorRange(handle, limit + 1, 0), info }))
}

export async function readRegularFileTail(path: string, limit: number): Promise<BoundedRegularFile> {
  return withRegularFile(path, async (handle, info) => {
    const length = Math.min(info.size, limit)
    return {
      bytes: await readDescriptorRange(handle, length, info.size - length),
      info,
      truncated: info.size > limit,
    }
  })
}

export async function readPrivateBytes(trustedRoot: string, path: string): Promise<RegularFile> {
  return withRegularFile(await canonicalPath(trustedRoot, path), async (handle, info) => ({ bytes: await handle.readFile(), info }))
}

export async function verifyRegularPrivateFile(trustedRoot: string, path: string): Promise<string> {
  const destination = await canonicalPath(trustedRoot, path)
  await withRegularFile(destination, async () => undefined)
  return destination
}
