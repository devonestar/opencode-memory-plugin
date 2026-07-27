import { join } from "node:path"
import type { RunManifest } from "./artifacts"
import { writePrivate } from "./private-fs"
import type { ProposalValidation } from "./proposal"
import type { MemorySnapshot } from "./snapshot"

export const INTEGRITY_BOUNDARY = "Artifact hashes detect accidental corruption or tampering inside the memory tree. The same OS user can modify plugin code or configuration and is outside this integrity boundary without external key management."

export type ReportRun = {
  readonly dir: string
  readonly id: string
  readonly status: RunManifest["status"]
}

export type ReportReview = {
  readonly snapshot: MemorySnapshot
  readonly validation: ProposalValidation
}

export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+.!|\-]/g, "\\$&")
}

export async function writeReports(privateRoot: string, run: ReportRun, review: ReportReview): Promise<void> {
  const operationLine = (prefix: "APPLY" | "REPORT", operation: ProposalValidation["proposal"]["operations"][number]): string => {
    const sources = operation.sources.map((source) => `${source.scope}:${source.slug}`).join(", ")
    const destination = operation.kind === "KEEP" || operation.kind === "DELETE" ? "none" : `${operation.replacement.scope}:${operation.replacement.slug}`
    return `- ${prefix} ${escapeMarkdown(operation.id)}: ${operation.kind} (${operation.confidence}, ${escapeMarkdown(operation.reasonCode)}); sources=${escapeMarkdown(sources)}; destination=${escapeMarkdown(destination)}`
  }
  const applied = review.validation.applicable.map((operation) => operationLine("APPLY", operation))
  const reported = review.validation.reportOnly.map((operation) => operationLine("REPORT", operation))
  const errors = review.validation.errors.map((error) => `- ERROR ${escapeMarkdown(error)}`)
  const findings = review.validation.proposal.findings.map((finding) => `- ${finding.kind} [${escapeMarkdown(finding.slugs.join(", "))}]: ${escapeMarkdown(finding.summary).slice(0, 1000)}`)
  const report = [
    `# Memory curation ${run.id}`,
    "",
    `Status: ${run.status}`,
    `Snapshot: ${review.snapshot.sha256}`,
    `Reviewed topics: ${review.snapshot.topics.length}`,
    "",
    "Automatic mutation only keeps one existing exact-duplicate source unchanged and moves the other exact sources to trash. Model-authored replacement bytes are never written.",
    "Manual recovery uses .trash/<runId>/<slug>.md and .trash/<runId>/MEMORY.md.before; automatic curation never hard-deletes topics.",
    `Threat model: ${INTEGRITY_BOUNDARY}`,
    "Secret scanning is defense-in-depth and cannot prove that content is secret-free.",
    `Derived summary: reviewed=${review.validation.summary.reviewed}, high-confidence=${review.validation.summary.highConfidence}, ambiguous=${review.validation.summary.ambiguous}`,
    "",
    "## Operations",
    ...(applied.length + reported.length + errors.length === 0 ? ["- None"] : [...applied, ...reported, ...errors]),
    "",
    "## Findings",
    ...(findings.length === 0 ? ["- None"] : findings),
    "",
  ].join("\n")
  const diff = [
    `# Curation diff ${run.id}`,
    "",
    ...review.validation.applicable.map((operation) => {
      const sources = operation.sources.map((source) => `${source.scope}:${source.slug}`).join(", ")
      const destination = operation.kind === "DELETE" ? "trash only" : `${operation.replacement.scope}:${operation.replacement.slug}`
       return `- ${operation.kind} ${escapeMarkdown(sources)} -> ${escapeMarkdown(destination)}`
    }),
    "",
  ].join("\n")
  await Promise.all([writePrivate(privateRoot, join(run.dir, "report.md"), report), writePrivate(privateRoot, join(run.dir, "diff.md"), diff)])
}
