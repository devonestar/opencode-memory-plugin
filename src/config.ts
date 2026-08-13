import { createHash } from "node:crypto"
import { mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, parse } from "node:path"
import { ensurePrivateDir, ensurePrivateRoot, writePrivateExclusive } from "./private-fs"

/** Resolve opencode's global config root, honoring XDG_CONFIG_HOME like opencode itself. */
function resolveConfigRoot(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".config")
  return join(base, "opencode")
}

export const CONFIG_ROOT = resolveConfigRoot()
export const MEMORY_DIR = join(CONFIG_ROOT, "memory")
export const INDEX_FILENAME = "MEMORY.md"
export const PROJECTS_DIR = join(MEMORY_DIR, "projects")
export const PROJECT_METADATA_FILENAME = ".project.json"

export async function initializeMemoryRoots(memoryDir: string = MEMORY_DIR, projectsDir: string = PROJECTS_DIR): Promise<void> {
  await ensurePrivateRoot(memoryDir)
  await ensurePrivateDir(memoryDir, projectsDir)
  await ensurePrivateDir(memoryDir, join(memoryDir, ".curation"))
  await ensurePrivateDir(memoryDir, join(memoryDir, ".trash"))
  await initializeLifecycleRoots(memoryDir)
}

export async function initializeProjectStoreRoot(projectStoreDir: string): Promise<void> {
  await ensurePrivateDir(projectStoreDir, join(projectStoreDir, ".trash"))
  await initializeLifecycleRoots(projectStoreDir)
}

async function initializeLifecycleRoots(storeRoot: string): Promise<void> {
  await ensurePrivateDir(storeRoot, join(storeRoot, ".archive", "entries"))
  await ensurePrivateDir(storeRoot, join(storeRoot, ".user-trash", "entries"))
  await ensurePrivateDir(storeRoot, join(storeRoot, ".memory-lifecycle", "transactions"))
}

export type ProjectIdentity = {
  readonly id: string
  readonly worktree: string
}

export class ProjectDirectoryRootError extends Error {
  readonly name = "ProjectDirectoryRootError"
  constructor(readonly directory: string) {
    super(`project directory resolves to a filesystem root: ${directory}`)
  }
}

export async function resolveProjectNamespace(project: ProjectIdentity, directory: string): Promise<string> {
  if (project.id !== "global") return `project-${shortHash(project.id, 16)}`
  const canonicalDirectory = await realpath(directory)
  if (parse(canonicalDirectory).root === canonicalDirectory) throw new ProjectDirectoryRootError(canonicalDirectory)
  const readableName = sanitizeBasename(basename(canonicalDirectory))
  return `local-${readableName}-${shortHash(`directory:${canonicalDirectory}`, 12)}`
}

export async function resolveProjectMemoryDir(project: ProjectIdentity, directory: string, projectsRoot: string = PROJECTS_DIR): Promise<string> {
  const namespace = await resolveProjectNamespace(project, directory)
  const dir = join(projectsRoot, namespace)
  await mkdir(projectsRoot, { recursive: true, mode: 0o700 })
  await ensurePrivateDir(projectsRoot, dir)
  const metadata = `${JSON.stringify({ id: project.id, worktree: project.worktree, directory, createdAt: new Date().toISOString() }, null, 2)}\n`
  await writePrivateExclusive(projectsRoot, join(dir, PROJECT_METADATA_FILENAME), metadata)
  return dir
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length)
}

function sanitizeBasename(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)
  return sanitized.length > 0 ? sanitized : "workspace"
}

/** Index load bounds — mirror Claude Code auto-memory: 200 lines OR 25KB, hard read cap 100KB. */
export const INDEX_MAX_LINES = 200
export const INDEX_MAX_BYTES = 25_000
export const INDEX_HARD_CAP_BYTES = 100_000

/** Write-time size accounting: warn at 80% of the cap, tell the model to compact to 70%. */
export const INDEX_WARN_RATIO = 0.8
export const INDEX_TARGET_RATIO = 0.7

/** Index pointer entries stay one short line. */
export const POINTER_MAX_CHARS = 150
