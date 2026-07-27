import { randomUUID } from "node:crypto"
import { link, lstat, mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises"
import { dirname } from "node:path"

export async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, content)
  await rename(temporary, path)
}

export class LockTimeoutError extends Error {
  readonly name = "LockTimeoutError"
  constructor(readonly lockPath: string) {
    super(`could not acquire lock: ${lockPath}`)
  }
}

export type LockOptions = {
  readonly retryMs?: number
  readonly maxRetries?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly isProcessAlive?: (pid: number) => boolean
  readonly onMetadataPrepared?: (path: string) => Promise<void>
  readonly onDeadOwnerObserved?: (path: string) => Promise<void>
  readonly onQuarantined?: (path: string) => Promise<void>
}

type LockIdentity = { readonly token: string; readonly pid: number }
type LockInode = { readonly dev: number; readonly ino: number }
type LockSnapshot = LockInode & { readonly raw: string; readonly identity: LockIdentity | null }
type LockOwner = LockIdentity & LockInode
type LockRuntime = Required<Pick<LockOptions, "retryMs" | "maxRetries" | "sleep" | "isProcessAlive">> & Pick<LockOptions, "onMetadataPrepared" | "onDeadOwnerObserved" | "onQuarantined">

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}

function runtime(options: LockOptions): LockRuntime {
  return {
    retryMs: options.retryMs ?? 50,
    maxRetries: options.maxRetries ?? 1_300,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    isProcessAlive: options.isProcessAlive ?? isProcessAlive,
    ...(options.onMetadataPrepared === undefined ? {} : { onMetadataPrepared: options.onMetadataPrepared }),
    ...(options.onDeadOwnerObserved === undefined ? {} : { onDeadOwnerObserved: options.onDeadOwnerObserved }),
    ...(options.onQuarantined === undefined ? {} : { onQuarantined: options.onQuarantined }),
  }
}

export async function withLock<T>(lockPath: string, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const owner = await acquire(lockPath, runtime(options))
  try {
    return await work()
  } finally {
    await release(lockPath, owner)
  }
}

async function acquire(lockPath: string, timing: LockRuntime): Promise<LockOwner> {
  const identity = { token: randomUUID(), pid: process.pid }
  for (let attempt = 0; attempt < timing.maxRetries; attempt += 1) {
    const owner = await tryCreate(lockPath, identity, timing)
    if (owner !== null) return owner
    await reclaimDeadOwner(lockPath, timing)
    await timing.sleep(timing.retryMs)
  }
  throw new LockTimeoutError(lockPath)
}

async function tryCreate(lockPath: string, identity: LockIdentity, timing: LockRuntime): Promise<LockOwner | null> {
  const temporary = `${lockPath}.owner-${process.pid}-${randomUUID()}`
  let handle: FileHandle | undefined
  try {
    handle = await open(temporary, "wx", 0o600)
    await handle.writeFile(`${JSON.stringify(identity)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await timing.onMetadataPrepared?.(temporary)
    try {
      await link(temporary, lockPath)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return null
      throw error
    }
    const info = await lstat(lockPath)
    return { ...identity, dev: info.dev, ino: info.ino }
  } finally {
    if (handle !== undefined) await handle.close()
    await rm(temporary, { force: true })
  }
}

async function release(lockPath: string, owner: LockOwner): Promise<void> {
  const snapshot = await readSnapshot(lockPath)
  if (sameInode(snapshot, owner) && sameIdentity(snapshot?.identity, owner)) await rm(lockPath)
}

async function reclaimDeadOwner(lockPath: string, timing: LockRuntime): Promise<void> {
  const observed = await readSnapshot(lockPath)
  if (observed === null || (observed.identity !== null && timing.isProcessAlive(observed.identity.pid))) return
  await timing.onDeadOwnerObserved?.(lockPath)
  const quarantine = `${lockPath}.quarantine-${observed.dev}-${observed.ino}`
  try {
    await link(lockPath, quarantine)
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EEXIST")) return
    throw error
  }
  try {
    await timing.onQuarantined?.(quarantine)
    const [current, quarantined] = await Promise.all([readSnapshot(lockPath), readSnapshot(quarantine)])
    if (sameInode(current, observed) && sameInode(quarantined, observed) && current?.raw === observed.raw && quarantined?.raw === observed.raw) {
      await rm(lockPath)
    }
  } finally {
    await rm(quarantine, { force: true })
  }
}

function sameInode(left: LockInode | null | undefined, right: LockInode): boolean {
  return left?.dev === right.dev && left.ino === right.ino
}

function sameIdentity(left: LockIdentity | null | undefined, right: LockIdentity): boolean {
  return left?.token === right.token && left.pid === right.pid
}

async function readSnapshot(lockPath: string): Promise<LockSnapshot | null> {
  let info
  let raw: string
  try {
    info = await lstat(lockPath)
    raw = await readFile(lockPath, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return { dev: info.dev, ino: info.ino, raw, identity: null }
  }
  if (typeof decoded !== "object" || decoded === null || !("token" in decoded) || !("pid" in decoded)) return { dev: info.dev, ino: info.ino, raw, identity: null }
  const token = decoded.token
  const pid = decoded.pid
  return typeof token === "string" && token.length > 0 && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
    ? { dev: info.dev, ino: info.ino, raw, identity: { token, pid } }
    : { dev: info.dev, ino: info.ino, raw, identity: null }
}
