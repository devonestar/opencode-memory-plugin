import { opendir } from "node:fs/promises"
import { canonicalPath, captureTrustedDirectory, readRegularFilePrefix, verifyTrustedDirectory, type RegularFile } from "./private-fs"

export class PrivateLimitError extends Error {
  readonly name = "PrivateLimitError"
  constructor(readonly path: string, readonly limit: number, readonly kind: "bytes" | "entries") {
    super(`private ${kind} limit exceeded for ${path}: ${limit}`)
  }
}

export async function readPrivateFilePrefix(trustedRoot: string, path: string, limit: number): Promise<RegularFile> {
  const root = await captureTrustedDirectory(await canonicalPath(trustedRoot, trustedRoot))
  const destination = await canonicalPath(trustedRoot, path)
  const file = await readRegularFilePrefix(destination, limit)
  await verifyTrustedDirectory(root)
  return file
}

export async function readPrivateBytesBounded(trustedRoot: string, path: string, limit: number): Promise<RegularFile> {
  const file = await readPrivateFilePrefix(trustedRoot, path, limit)
  if (file.bytes.byteLength > limit) throw new PrivateLimitError(path, limit, "bytes")
  return file
}

export async function listPrivateDirectory(trustedRoot: string, path: string, limit: number): Promise<readonly string[]> {
  const root = await captureTrustedDirectory(await canonicalPath(trustedRoot, trustedRoot))
  const directory = await captureTrustedDirectory(await canonicalPath(trustedRoot, path))
  const handle = await opendir(directory.path)
  const names: string[] = []
  for await (const entry of handle) {
    names.push(entry.name)
    if (names.length > limit) throw new PrivateLimitError(path, limit, "entries")
  }
  await Promise.all([verifyTrustedDirectory(root), verifyTrustedDirectory(directory)])
  return names.sort()
}
