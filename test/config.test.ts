import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import {
  initializeMemoryRoots,
  initializeProjectStoreRoot,
  PROJECT_METADATA_FILENAME,
  resolveProjectMemoryDir,
  resolveProjectNamespace,
} from "../src/config"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mem-config-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("project memory namespace", () => {
  test("derives a safe stable namespace from a git project id", async () => {
    // Given a git project identity
    const project = { id: "github.com/acme/product", worktree: "/workspace/product" }

    // When its namespace is resolved twice
    const first = await resolveProjectNamespace(project, dir)
    const second = await resolveProjectNamespace(project, dir)

    // Then the result is stable and contains filesystem-safe characters only
    expect(first).toBe(second)
    expect(first).toMatch(/^project-[a-f0-9]{16}$/)
  })

  test("keeps the existing git namespace for a fixed project id", async () => {
    // Given a fixed git project identity and an unrelated working directory
    const project = { id: "github.com/acme/product", worktree: "/workspace/product" }

    // When its namespace is resolved with the top-level directory
    const namespace = await resolveProjectNamespace(project, dir)

    // Then the project-id-derived namespace remains byte-identical
    expect(namespace).toBe("project-8265aa5b43fc33e9")
  })

  test("derives a local namespace from the canonical non-git directory", async () => {
    // Given opencode's global project id for a real non-git directory
    const project = { id: "global", worktree: dir }

    // When its namespace is resolved
    const namespace = await resolveProjectNamespace(project, dir)

    // Then it carries a readable basename and a path-derived hash
    expect(namespace).toMatch(/^local-mem-config-[a-z0-9-]+-[a-f0-9]{12}$/)
  })

  test("derives different non-git namespaces from different top-level directories", async () => {
    // Given one global project identity used from two real directories
    const project = { id: "global", worktree: "/" }
    const firstDirectory = await mkdtemp(join(dir, "first-"))
    const secondDirectory = await mkdtemp(join(dir, "second-"))

    // When each top-level directory is resolved
    const first = await resolveProjectNamespace(project, firstDirectory)
    const second = await resolveProjectNamespace(project, secondDirectory)

    // Then each non-git workspace has an isolated namespace
    expect(first).not.toBe(second)
  })

  test("rejects a non-git top-level directory that canonicalizes to a filesystem root", async () => {
    // Given opencode's global identity and root directory fallback
    const project = { id: "global", worktree: "/" }

    // When namespace resolution canonicalizes the top-level directory
    const resolution = resolveProjectNamespace(project, "/")

    // Then no machine-wide project namespace is produced
    await expect(resolution).rejects.toThrow("filesystem root")
  })

  test("does not allow a hostile project id to escape the projects root", async () => {
    // Given an id containing traversal and separator characters
    const namespace = await resolveProjectNamespace({ id: "../../outside/../escape", worktree: dir }, dir)

    // When it is joined to the configured projects root
    const resolved = join(dir, namespace)
    const child = relative(dir, resolved)

    // Then the namespace remains one relative path segment under that root
    expect(isAbsolute(child)).toBe(false)
    expect(child.startsWith("..")).toBe(false)
    expect(child).not.toContain("/")
  })

  test("creates human-readable project metadata inside the namespace", async () => {
    // Given a project and an isolated projects root
    const project = { id: "git-project-id", worktree: "/workspace/original" }

    // When its memory directory is initialized
    const projectDir = await resolveProjectMemoryDir(project, "/workspace/original", dir)
    const metadata = await readFile(join(projectDir, PROJECT_METADATA_FILENAME), "utf8")

    // Then the sidecar records the original identity and a creation timestamp
    expect(metadata).toContain('"id": "git-project-id"')
    expect(metadata).toContain('"worktree": "/workspace/original"')
    expect(metadata).toContain('"directory": "/workspace/original"')
    expect(metadata).toContain('"createdAt":')
  })

  test("initializes private memory roots with owner-only permissions", async () => {
    const memoryDir = join(dir, "memory")
    const projectsDir = join(memoryDir, "projects")

    await initializeMemoryRoots(memoryDir, projectsDir)

    const [memoryStat, projectsStat, curationStat, trashStat, archiveStat, userTrashStat, transactionsStat] = await Promise.all([
      stat(memoryDir),
      stat(projectsDir),
      stat(join(memoryDir, ".curation")),
      stat(join(memoryDir, ".trash")),
      stat(join(memoryDir, ".archive", "entries")),
      stat(join(memoryDir, ".user-trash", "entries")),
      stat(join(memoryDir, ".memory-lifecycle", "transactions")),
    ])
    expect(memoryStat.mode & 0o777).toBe(0o700)
    expect(projectsStat.mode & 0o777).toBe(0o700)
    expect(curationStat.mode & 0o777).toBe(0o700)
    expect(trashStat.mode & 0o777).toBe(0o700)
    expect(archiveStat.mode & 0o777).toBe(0o700)
    expect(userTrashStat.mode & 0o777).toBe(0o700)
    expect(transactionsStat.mode & 0o777).toBe(0o700)
  })

  test("initializes a private project store trash root with owner-only permissions", async () => {
    const projectDir = join(dir, "memory", "projects", "local-project")
    await initializeMemoryRoots(join(dir, "memory"), join(dir, "memory", "projects"))
    await mkdir(projectDir, { recursive: true, mode: 0o700 })

    await initializeProjectStoreRoot(projectDir)

    const [trashStat, archiveStat, userTrashStat, transactionsStat] = await Promise.all([
      stat(join(projectDir, ".trash")),
      stat(join(projectDir, ".archive", "entries")),
      stat(join(projectDir, ".user-trash", "entries")),
      stat(join(projectDir, ".memory-lifecycle", "transactions")),
    ])
    expect(trashStat.mode & 0o777).toBe(0o700)
    expect(archiveStat.mode & 0o777).toBe(0o700)
    expect(userTrashStat.mode & 0o777).toBe(0o700)
    expect(transactionsStat.mode & 0o777).toBe(0o700)
  })
})
