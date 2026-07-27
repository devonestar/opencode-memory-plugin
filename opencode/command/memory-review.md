---
description: Audit accumulated memories with a subagent and propose merges, rewrites, and deletions — review only, never writes
agent: build
---

# /memory-review — batch memory audit

Audit the persisted memory stores and **propose** corrections. This command is deliberately
**review-only**: it must not write, edit, or delete any memory file. The user approves changes,
then applies them in a normal turn.

This is the deferred-validation half of the memory pipeline. Saves are gated cheaply and
deterministically at write time (secret rejection, minimum body length, cross-scope duplicate
detection, pointer length). Judgement-heavy curation — "is this actually worth remembering?" —
happens here, in batch, so it never adds latency or a failure mode to a save.

The memory root is `${XDG_CONFIG_HOME:-~/.config}/opencode/memory/`; when `XDG_CONFIG_HOME`
is unset or empty, this expands to `~/.config/opencode/memory/`.

When enabled, automatic curation runs rarely and writes private reports under
`${XDG_CONFIG_HOME:-~/.config}/opencode/memory/.curation/projects/<namespace>/runs/<run-id>/report.md`. Use
`/memory-curation-status` to confirm whether a report exists without exposing internal paths. This command remains the manual, review-only
fallback for ambiguous findings and never applies changes.

## Stores to audit

- **Global**: `${XDG_CONFIG_HOME:-~/.config}/opencode/memory/` — `MEMORY.md` index plus `<slug>.md` topic files
- **Project**: `${XDG_CONFIG_HOME:-~/.config}/opencode/memory/projects/<namespace>/` — same layout, one namespace per
  repository identity (git remote) or per canonical directory (non-git)

## Procedure

1. Read every `MEMORY.md` index, then read every topic file it points to. Do this with parallel
   reads — do not read them one at a time.
2. Dispatch the analysis through the active primary agent's available subagent mechanism so the
   raw memory bodies do not consume the main context. Ask that subagent to load the `memory-types`
   skill when available and give it the audit brief below with the file contents inlined. Do not
   assume a specific task tool, category name, or call syntax exists.

3. Present the subagent's findings to the user as a numbered list of proposed actions, each with
   the evidence that justifies it. Wait for approval. Apply nothing on your own.

## Audit brief for the subagent

For each memory, decide exactly one verdict and justify it in one line:

- **KEEP** — non-derivable, still true, earns its index line.
- **MERGE** — overlaps another memory. Name the surviving slug and the merged description.
- **REWRITE** — right content, wrong shape. Flag any of:
  - index `description` too vague to judge relevance from alone
  - index line over 150 characters, meaning detail belongs in the topic body instead
  - `feedback` or `project` body missing the `**Why:**` / `**How to apply:**` structure
  - relative dates that should have been absolute (`last Thursday` → `2026-07-24`)
- **DELETE** — should never have been persisted, or is now false. Specifically flag:
  - code, architecture, file paths, project structure — the code is authoritative
  - git history or who-changed-what — `git log` / `git blame` are authoritative
  - fix recipes and debugging solutions — those live in the commit
  - anything already stated in `AGENTS.md` / `CLAUDE.md`
  - ephemeral state: in-progress work, current-conversation context
  - any memory naming a file, function, or flag that **no longer exists** — verify before judging
- **RESCOPE** — stored in the wrong scope. A repository-specific fact sitting in `global`
  pollutes every workspace; an org-wide fact sitting in `project` will not be found from
  another repository. Name the correct scope.

Also report, across the whole set:

- **Duplicate clusters** — groups covering the same ground, with the single slug that should survive.
- **Index health** — total pointer count and total index bytes per scope. The injected block budget
  is 10KB combined with roughly 8KB for pointers, split 60% project / 40% global with spillover, and
  a secondary cap near 80 pointer lines. If a scope is close to its share, say which pointers are the
  weakest and should be dropped or demoted first.
- **Contradictions** — memories that disagree with each other. Name both and say which is newer.

## Hard constraints

- **Do not write, edit, or delete anything.** Output proposals only.
- Do not invent memories that are not on disk.
- Quote the specific line or body fragment that justifies each non-KEEP verdict.
- If a store is empty or absent, say so plainly rather than inferring content.
