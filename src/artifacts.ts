import { createHash } from "node:crypto"
import { tool } from "@opencode-ai/plugin"
import { basename, join } from "node:path"
import type { ProposalValidation, Replacement } from "./proposal"
import { readPrivate, writePrivate } from "./private-fs"
import type { MemorySnapshot, SnapshotScope } from "./snapshot"
import { RUN_ID_RE } from "./curation-state"
import { scanForSecret } from "./secrets"
import { escapeMarkdown, INTEGRITY_BOUNDARY, writeReports } from "./reports"

export type ManifestTopic = {
  readonly scope: SnapshotScope
  readonly slug: string
  readonly sha256: string
}

export type RunManifest = {
  readonly version: 1
  readonly runId: string
  readonly status: "running" | "applying" | "applied" | "report-only" | "stale" | "dry-run" | "validation-failed" | "failed" | "timeout"
  readonly preSnapshotSha256: string
  readonly postSnapshotSha256?: string
  readonly planSha256?: string
  readonly originals: readonly ManifestTopic[]
  readonly replacements: readonly ManifestTopic[]
  readonly reportPath: string
}

export type JournalEntry = {
  readonly phase: string
  readonly at: number
  readonly detail?: string
}

const z = tool.schema
const manifestTopicSchema = z.object({ scope: z.enum(["global", "project"]), slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const manifestSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().regex(RUN_ID_RE),
    status: z.enum(["running", "applying", "applied", "report-only", "stale", "dry-run", "validation-failed", "failed", "timeout"]),
    preSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    postSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    planSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    originals: z.array(manifestTopicSchema),
    replacements: z.array(manifestTopicSchema),
    reportPath: z.string().min(1),
  })
  .strict()

export function replacementTopic(replacement: Replacement): ManifestTopic {
  const content = ["---", `name: ${replacement.slug}`, `description: ${replacement.description}`, "metadata:", `  type: ${replacement.type}`, "---", "", replacement.body.trimEnd(), ""].join("\n")
  return { scope: replacement.scope, slug: replacement.slug, sha256: createHash("sha256").update(content).digest("hex") }
}

export async function writeManifest(privateRoot: string, runDir: string, manifest: RunManifest): Promise<void> {
  await writePrivate(privateRoot, join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

export async function readManifest(privateRoot: string, runDir: string): Promise<RunManifest> {
  let decoded: unknown
  try {
    decoded = JSON.parse(await readPrivate(privateRoot, join(runDir, "manifest.json")))
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError("curation manifest is malformed")
    throw error
  }
  const parsed = manifestSchema.safeParse(decoded)
  if (!parsed.success) throw new TypeError(`curation manifest is malformed: ${parsed.error.message}`)
  const data = parsed.data
  if (data.runId !== basename(runDir) || data.reportPath !== join(runDir, "report.md")) throw new TypeError("curation manifest contains an unsafe run or report path")
  const base = {
    version: data.version,
    runId: data.runId,
    status: data.status,
    preSnapshotSha256: data.preSnapshotSha256,
    originals: data.originals,
    replacements: data.replacements,
    reportPath: data.reportPath,
  }
  return {
    ...base,
    ...(data.postSnapshotSha256 === undefined ? {} : { postSnapshotSha256: data.postSnapshotSha256 }),
    ...(data.planSha256 === undefined ? {} : { planSha256: data.planSha256 }),
  }
}

export async function writeJournal(privateRoot: string, runDir: string, entries: readonly JournalEntry[]): Promise<void> {
  await writePrivate(privateRoot, join(runDir, "journal.json"), `${JSON.stringify({ version: 1, phases: entries }, null, 2)}\n`)
}

export async function writeProposal(privateRoot: string, runDir: string, validation: ProposalValidation): Promise<void> {
  await writePrivate(privateRoot, join(runDir, "proposal.json"), `${JSON.stringify(validation.proposal, null, 2)}\n`)
}

function safeReportMessage(value: string): string {
  const oneLine = value.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 1000)
  return scanForSecret(oneLine) === null ? escapeMarkdown(oneLine) : "Details redacted because they matched the secret scanner."
}

export async function writeReviewArtifacts(
  privateRoot: string,
  runDir: string,
  runId: string,
  snapshot: MemorySnapshot,
  validation: ProposalValidation,
  status: "dry-run" | "report-only" | "validation-failed",
  at: number,
): Promise<RunManifest> {
  const originals = new Map<string, ManifestTopic>()
  const replacements: ManifestTopic[] = []
  for (const operation of validation.applicable) {
    for (const source of operation.sources) originals.set(`${source.scope}:${source.slug}`, source)
    if (operation.kind !== "DELETE") replacements.push(replacementTopic(operation.replacement))
  }
  const manifest = {
    version: 1,
    runId,
    status,
    preSnapshotSha256: snapshot.sha256,
    originals: [...originals.values()],
    replacements,
    reportPath: join(runDir, "report.md"),
  } satisfies RunManifest
  await Promise.all([
    writeManifest(privateRoot, runDir, manifest),
    writeProposal(privateRoot, runDir, validation),
    writeJournal(privateRoot, runDir, [{ phase: status, at }]),
    writeReports(privateRoot, { dir: runDir, id: runId, status }, { snapshot, validation }),
  ])
  return manifest
}

export async function initializeRunArtifacts(privateRoot: string, runDir: string, runId: string, snapshot: MemorySnapshot, at: number): Promise<void> {
  const manifest = {
    version: 1,
    runId,
    status: "running",
    preSnapshotSha256: snapshot.sha256,
    originals: [],
    replacements: [],
    reportPath: join(runDir, "report.md"),
  } satisfies RunManifest
  await Promise.all([
    writeManifest(privateRoot, runDir, manifest),
    writePrivate(privateRoot, join(runDir, "proposal.json"), `${JSON.stringify({ version: 1, status: "pending" }, null, 2)}\n`),
    writeJournal(privateRoot, runDir, [{ phase: "reserved", at }]),
    writePrivate(privateRoot, join(runDir, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`),
    writePrivate(privateRoot, join(runDir, "report.md"), `# Memory curation ${runId}\n\nStatus: running\n`),
    writePrivate(privateRoot, join(runDir, "diff.md"), `# Curation diff ${runId}\n\n- Pending\n`),
  ])
}

export async function writeFailureArtifacts(
  privateRoot: string,
  runDir: string,
  runId: string,
  snapshot: MemorySnapshot,
  status: "failed" | "timeout",
  message: string,
  at: number,
): Promise<RunManifest> {
  const safeMessage = safeReportMessage(message)
  const manifest = {
    version: 1,
    runId,
    status,
    preSnapshotSha256: snapshot.sha256,
    originals: [],
    replacements: [],
    reportPath: join(runDir, "report.md"),
  } satisfies RunManifest
  await Promise.all([
    writeManifest(privateRoot, runDir, manifest),
    writeJournal(privateRoot, runDir, [{ phase: status, at, detail: safeMessage }]),
    writePrivate(privateRoot, join(runDir, "report.md"), `# Memory curation ${runId}\n\nStatus: ${status}\n\nThreat model: ${INTEGRITY_BOUNDARY}\n\n${safeMessage}\n`),
    writePrivate(privateRoot, join(runDir, "diff.md"), `# Curation diff ${runId}\n\n- No changes applied\n`),
  ])
  return manifest
}

export async function writeOrphanFailureArtifacts(
  privateRoot: string,
  runDir: string,
  runId: string,
  preSnapshotSha256: string,
  status: "failed" | "timeout",
  message: string,
  at: number,
): Promise<RunManifest> {
  const safeMessage = safeReportMessage(message)
  const manifest = {
    version: 1,
    runId,
    status,
    preSnapshotSha256,
    originals: [],
    replacements: [],
    reportPath: join(runDir, "report.md"),
  } satisfies RunManifest
  await Promise.all([
    writeManifest(privateRoot, runDir, manifest),
    writeJournal(privateRoot, runDir, [{ phase: status, at, detail: safeMessage }]),
    writePrivate(privateRoot, join(runDir, "report.md"), `# Memory curation ${runId}\n\nStatus: ${status}\n\nThreat model: ${INTEGRITY_BOUNDARY}\n\n${safeMessage}\n`),
    writePrivate(privateRoot, join(runDir, "diff.md"), `# Curation diff ${runId}\n\n- No changes applied\n`),
  ])
  return manifest
}
