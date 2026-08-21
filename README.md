# OpenCode Durable Memory

Local-first durable memory for the OpenCode coding agent. Plain Markdown on disk, deterministic BM25F recall, and curation that cannot silently rewrite what you saved.

[English](README.md) | [한국어](README.ko.md)

This plugin gives OpenCode memory that survives across sessions. Each memory is one human-readable Markdown file under `${XDG_CONFIG_HOME:-~/.config}/opencode/memory/`. A compact pointer index is injected into the system prompt and bodies stay on disk until a tool reads them, so memory does not consume context it is not being used for. Global memories and per-workspace project memories live in separate stores. There is no database, no embedding model, no API key, and no network call on the read path.

## Why this plugin

Durable agent memory usually fails in one of three ways: it loses facts, it silently rewrites them, or it quietly eats the context window. Each guarantee below closes one of those failures, and each is enforced by the normative contract in [Memory lifecycle and recall](#memory-lifecycle-and-recall).

| Guarantee | What it means in practice |
| --- | --- |
| **Plain Markdown, no database** | One `MEMORY.md` index plus one `<slug>.md` file per topic. Read, grep, diff, and edit memory in your own editor. Nothing is opaque or vendor-locked. |
| **No embeddings, no vector store** | `memory_recall` ranks with BM25F over slug, description, and body at request time. No model download, no index build, no API key, no cold start. |
| **Deterministic ranking** | The same corpus and query always produce the same order: descending score, then global before project, then slug by Unicode code point. Recall never calls a model, reads transcripts, or mutates memory. |
| **Korean and CJK recall works** | Tokenization includes Korean character n-grams, so text without word spacing stays searchable without a language model. |
| **Two stores, never mixed** | A scoped operation never falls back to the other scope, and a cross-scope search fails as a whole rather than returning half an answer. A broken store is fenced without disabling the healthy one. |
| **Only your main session can write** | Child and subagent sessions get `SESSION_NOT_VERIFIED`. Subagent chatter cannot pollute long-term memory. |
| **Curation proves before it applies** | Automatic apply is limited to a `duplicate-exact` merge, checked locally by parsed `type`, `description`, and `body` equality, with SHA-256 hashes fencing stale or tampered sources. Every semantic judgment such as similar, stale, or superseded is report-only and waits for your approval. |
| **Curation is reversible and bounded** | Recoverable pre-images are archived under `.trash/<runId>/` before any applied change, curation never hard-deletes a memory file, the curator subagent has no tools at all, and at most three suggestions reach one session. Pause, resume, force a run, or inspect status from slash commands. |
| **Nothing is hard-deleted** | Archive and delete each move one immutable entry that keeps its origin metadata. Restore addresses one exact `(scope, source, entry_id)` tuple and never overwrites, merges, or renames. An occupied slug returns `ACTIVE_COLLISION` and mutates nothing. |
| **Crash-safe by fencing, not guessing** | An interrupted mutation either converges idempotently to its committed result or that store is fenced with `RECOVERY_BLOCKED`. A partial bundle never becomes visible to a reader. |
| **Bounded context cost** | The injected block, pointer lines, and per-scope share are byte-budgeted and configurable. Recall caps at 200 topics, 32 KiB per topic, 512 KiB aggregate, and a 25,000-byte response, and returns metadata only, never bodies. |
| **The README is the contract** | RFC 2119 requirements, an exhaustive public error matrix, and acceptance scenarios. A runtime change that alters observable behavior has to change that section in the same revision. |

## How it compares

| Approach | Where this plugin differs |
| --- | --- |
| Static instruction files such as `AGENTS.md` or `CLAUDE.md` | They sit fully in context, have no lifecycle or scoping, and grow without a budget. Here only a pointer index is injected and bodies are fetched on demand. |
| Hosted memory services | They need an API key and a network round trip, your facts leave the machine, and ranking is opaque. Here everything runs locally and the ranking formula is written down. |
| Embedding-based local plugins | They ship a model, build an index, return non-deterministic neighbours, and rarely guarantee CJK behavior. BM25F is instant, reproducible, and tokenizes Korean n-grams. |
| Agent-managed memory | A model decides what to merge or drop. Here a model may only propose, and the single automatic apply is a locally proven exact duplicate. |

The cost of this design is stated plainly: recall is lexical, so it will not surface a memory that shares no terms with your query. That is a deliberate trade for determinism, auditability, and zero inference cost.

## Install

Requires the `opencode` CLI and [Bun](https://bun.sh). The plugin runs from a local checkout that OpenCode loads by absolute path. It is not published on npm, so the four steps below are the whole installation and they are safe to run in order without editing any placeholder.

**1. Clone and verify the checkout.**

```sh
git clone https://github.com/devonestar/opencode-durable-memory.git
cd opencode-durable-memory
bun install
bun run typecheck
```

**2. Register the plugin.** Add the absolute path to `src/index.ts` as one entry of the `plugin` array in `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.jsonc`. Print the exact value with `echo "$(pwd)/src/index.ts"`.

```jsonc
{
  "plugin": ["/absolute/path/to/opencode-durable-memory/src/index.ts"]
}
```

That bare string entry is a complete install. Save, recall, and lifecycle tools all work, and curation stays inert because `allowProviderEgress` defaults to `false`, so no memory content reaches a model provider until you opt in. [OpenCode wiring](#opencode-wiring) documents the tuple form that enables curation and tunes injection budgets.

**3. Link the agent, command, and skill assets.** Run this from the repository root; it resolves its own paths.

```sh
REPO="$(pwd)"
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

mkdir -p "$CONFIG_ROOT/agent" "$CONFIG_ROOT/command" "$CONFIG_ROOT/skills/memory-types"
ln -sfn "$REPO/opencode/agent/memory-curator.md" "$CONFIG_ROOT/agent/memory-curator.md"
ln -sfn "$REPO/opencode/command/memory-review.md" "$CONFIG_ROOT/command/memory-review.md"
ln -sfn "$REPO/opencode/command/memory-curation-status.md" "$CONFIG_ROOT/command/memory-curation-status.md"
ln -sfn "$REPO/opencode/command/memory-curation-run.md" "$CONFIG_ROOT/command/memory-curation-run.md"
ln -sfn "$REPO/opencode/command/memory-curation-pause.md" "$CONFIG_ROOT/command/memory-curation-pause.md"
ln -sfn "$REPO/opencode/command/memory-curation-resume.md" "$CONFIG_ROOT/command/memory-curation-resume.md"
ln -sfn "$REPO/opencode/skills/memory-types/SKILL.md" "$CONFIG_ROOT/skills/memory-types/SKILL.md"
```

**4. Restart and verify.** OpenCode loads configuration, plugins, agents, commands, and skills at startup, so quit and restart it, then check that all three resolved.

```sh
opencode debug config
opencode debug skill
```

### Tools

| Tool | Purpose |
| --- | --- |
| `memory_save(scope, type, slug, description, body)` | Persist one durable learning to the `global` or `project` store. |
| `memory_recall(query, scope, limit)` | Metadata-only BM25F search across active memory. |
| `memory_recall_archive(query, scope, limit)` | The same search over archived entries in one scope. |
| `memory_archive(scope, slug)` | Move one active topic out of use, keeping a recoverable entry. |
| `memory_delete(scope, slug)` | Move one active topic to user trash, keeping a recoverable entry. |
| `memory_restore(scope, source, entry_id)` | Restore one exact entry at its original slug. |
| `memory_curation_status()` | Redacted curation state, eligibility metrics, and report availability. |
| `memory_curation_run(dryRun)` | Force one curation run, bypassing thresholds and cooldown. |
| `memory_curation_control(action)` | Pause or resume automatic and manual curation. |

### Commands

| Command | Purpose |
| --- | --- |
| `/memory-review` | Audit accumulated memories with a subagent and propose merges, rewrites, and deletions. Review only, never writes. |
| `/memory-curation-status` | Show curation status, eligibility metrics, and report availability. |
| `/memory-curation-run` | Force an asynchronous curation run that applies only locally validated safe operations. |
| `/memory-curation-pause` | Pause automatic and manual curation. |
| `/memory-curation-resume` | Resume automatic and manual curation. |

The plugin entry point is `src/index.ts`. It intentionally exports only a default plugin factory, because OpenCode invokes every exported function as a plugin.

## Memory data and scopes

Memory data is not stored in this repository. The runtime resolves the OpenCode config root from `XDG_CONFIG_HOME`, falling back to `~/.config` when it is unset or empty. In the paths below, `${XDG_CONFIG_HOME:-~/.config}` therefore expands to `~/.config` by default.

| Scope | On-disk path | Intended content |
| --- | --- | --- |
| Global | `${XDG_CONFIG_HOME:-~/.config}/opencode/memory/` | Person-level preferences, organization-wide systems, and workflows that apply across workspaces |
| Project | `${XDG_CONFIG_HOME:-~/.config}/opencode/memory/projects/<namespace>/` | Repository, product, or codebase-specific facts |

Do not move, copy into Git, or rewrite the live `${XDG_CONFIG_HOME:-~/.config}/opencode/memory/` tree when maintaining this repository.

## OpenCode wiring

The global config at `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.jsonc` loads this repository by absolute path. Keep the plugin order and curation values unchanged unless a separate behavior change is intended:

```jsonc
[
  "/absolute/path/to/opencode-durable-memory/src/index.ts",
  {
    "curation": {
      "enabled": true,
      "allowProviderEgress": true,
      "model": "openai/gpt-5.6-sol",
      "maxAgeDays": 30,
      "indexRatio": 0.7,
      "changedTopics": 10,
      "cooldownHours": 24,
      "timeoutSeconds": 120,
      "maxTopics": 200,
      "maxTopicBytes": 32768,
      "maxInputBytes": 524288,
      "maxOutputBytes": 131072,
      "notify": true
    }
  }
]
```

The tuple may also carry an optional `injection` group that tunes the system-prompt memory block budgets. Omitting the group, any key, or the whole tuple keeps the historical hard-coded budgets, so existing installations are unaffected:

```jsonc
{
  "injection": {
    "maxBlockBytes": 10000,
    "pointerBudgetBytes": 8000,
    "pointerMaxLines": 80,
    "projectShare": 0.6
  }
}
```

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `maxBlockBytes` | 10000 | 2048–100000 | UTF-8 byte cap for the whole injected memory block; pointers are dropped newest-last until the block fits |
| `pointerBudgetBytes` | 8000 | 512–100000 | Initial byte budget for index pointer lines before block-level trimming |
| `pointerMaxLines` | 80 | 1–1000 | Maximum number of index pointer lines across both scopes |
| `projectShare` | 0.6 | 0.05–0.95 | Fraction of the pointer budget reserved for project pointers; the remainder goes to global, and unused capacity spills over |

Unknown keys inside `injection`, and unknown top-level groups next to `curation`/`injection`, are rejected at plugin load rather than silently ignored.

OpenCode loads configuration, plugins, agents, commands, and skills at startup. Quit and restart OpenCode after changing this repository or any linked config asset.

## Config assets

The files under `opencode/` are the single ACTIVE editable copies of the memory-specific OpenCode assets:

- `opencode/agent/memory-curator.md`
- `opencode/command/memory-review.md`
- `opencode/command/memory-curation-status.md`
- `opencode/command/memory-curation-run.md`
- `opencode/command/memory-curation-pause.md`
- `opencode/command/memory-curation-resume.md`
- `opencode/skills/memory-types/SKILL.md`

Their standard discovery locations under `${XDG_CONFIG_HOME:-~/.config}/opencode/{agent,command,skills}/` contain seven absolute symlinks into this repository. Hidden backup directories may retain historical snapshots, but those snapshots are not active sources. Do not edit them or maintain a copied second tree.

If the repository moves:

1. In the live `opencode.jsonc`, replace the memory tuple's first element with the new absolute path to `src/index.ts`. JSONC does not expand the shell variables used below.
2. Recreate all seven symlinks with the new absolute repository path:

```sh
REPO="/absolute/path/to/opencode-durable-memory"
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

mkdir -p "$CONFIG_ROOT/agent" "$CONFIG_ROOT/command" "$CONFIG_ROOT/skills/memory-types"
ln -sfn "$REPO/opencode/agent/memory-curator.md" "$CONFIG_ROOT/agent/memory-curator.md"
ln -sfn "$REPO/opencode/command/memory-review.md" "$CONFIG_ROOT/command/memory-review.md"
ln -sfn "$REPO/opencode/command/memory-curation-status.md" "$CONFIG_ROOT/command/memory-curation-status.md"
ln -sfn "$REPO/opencode/command/memory-curation-run.md" "$CONFIG_ROOT/command/memory-curation-run.md"
ln -sfn "$REPO/opencode/command/memory-curation-pause.md" "$CONFIG_ROOT/command/memory-curation-pause.md"
ln -sfn "$REPO/opencode/command/memory-curation-resume.md" "$CONFIG_ROOT/command/memory-curation-resume.md"
ln -sfn "$REPO/opencode/skills/memory-types/SKILL.md" "$CONFIG_ROOT/skills/memory-types/SKILL.md"
```

3. From the relocated repository, run `bun run check`, `opencode debug config`, and `opencode debug skill`.
4. Quit and restart OpenCode so it loads the relocated plugin and linked assets.

## Development

Install the repository-local dependencies and run the quality gates with Bun:

```sh
bun install
bun test
bun run typecheck
bun run check
```

`bun run typecheck` and individual repository-local unit files, such as `bun test test/config.test.ts`, require only Bun and the installed repository dependencies. The full `bun run check` also runs the production-stack smoke test, so it requires the `opencode` CLI on `PATH` and a working live stack with OMO, Claude auth, the memory plugin tuple, and the linked agent, command, and skill assets.

## Memory lifecycle and recall

This section is the normative functional contract for lifecycle and explicit recall. The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are to be interpreted as described by RFC 2119 and RFC 8174 only when shown in uppercase. They describe externally observable behavior, not internal design preferences.

### Purpose and non-goals

Lifecycle tools let a verified primary session remove one durable memory from active use while retaining an exact recoverable entry, then restore that entry later. Recall tools provide bounded, metadata-only lexical discovery across active or archived memory.

This contract does not define hard deletion, retention expiry, vector or semantic search, transcript search, prompt injection, cross-scope fallback, partial results for `scope: "all"`, or automatic lifecycle decisions. "Indefinite" retention means the plugin has no purge operation or TTL. It does not protect data from manual filesystem deletion, storage failure, backup policy, or loss outside the plugin.

### Terms and store layout

- **Store**: one global or project memory root.
- **Active topic**: a valid `<slug>.md` topic represented by a valid pointer in the store's `MEMORY.md` index.
- **Lifecycle entry**: an immutable origin record and topic payload, plus current lifecycle state, identified by `entry_id` within one source and one scope.
- **Exact tuple**: `(scope, source, entry_id)`. Restore lookup never broadens any member of this tuple.
- **Verified primary session**: a session resolved as primary, with no parent session. Child sessions and sessions whose status cannot be resolved are unverified.
- **Recovery-blocked store**: a store whose lifecycle state cannot be safely reconciled or cross-validated.

Each store has these areas:

| Area | Contents | Injection visibility | Search visibility | Retention |
| --- | --- | --- | --- | --- |
| Store root | `MEMORY.md` and active topic files | Active index content is eligible for normal memory injection | Valid indexed topics are eligible for `memory_recall` | Until updated, archived, or deleted |
| `.archive/index.json` and `.archive/entries/<entry_id>/` | Canonical archive index and entries | Never | Current archived entries are eligible only for `memory_recall_archive` | Indefinite, subject to ordinary filesystem loss |
| `.user-trash/entries/<entry_id>/` | Entries created by `memory_delete` | Never | Never | Indefinite, subject to ordinary filesystem loss |
| `.trash/<runId>/` | Preimages from applied automatic curation | Never | Never | Indefinite, subject to ordinary filesystem loss |
| `.memory-lifecycle/transactions/` | Recovery records for lifecycle mutations | Never | Never | Internal recovery state |

### Requirements

- **AUTH-1**: Every lifecycle and recall tool MUST reject a child or unverified session with `SESSION_NOT_VERIFIED` before reading or mutating the requested corpus.
- **AUTH-2**: `memory_archive`, `memory_delete`, and `memory_restore` MUST be described to the agent as tools used only after an explicit user request. That rule governs agent selection of the tool. The plugin does not independently prove intent provenance and MUST NOT claim that it does. Once invoked from a verified primary session, no second confirmation is required.
- **SCOPE-1**: A lifecycle operation MUST use exactly one requested scope, `global` or `project`. It MUST NOT search, restore from, or fall back to the other scope.
- **SCOPE-2**: `memory_recall` MUST accept `all`, `global`, or `project`, defaulting to `all`. `all` MUST fail as a whole if either selected store is unavailable or recovery-blocked. `memory_recall_archive` MUST require exactly `global` or `project`.
- **SCOPE-3**: At startup, each scope MUST be classified independently as ready, unavailable, or recovery-blocked. A blocked scope MUST remain fenced from lifecycle mutation and recall without disabling an independently ready scope requested on its own.
- **STATE-1**: Archive and delete MUST each move one active topic to one new lifecycle entry. Archive sets source `archive` and state `archived`; delete sets source `trash` and state `trashed`.
- **STATE-2**: Restore MUST address one exact tuple. It MUST restore the original payload at the original slug, preserve origin metadata, and set current state to `restored`. It MUST NOT overwrite, merge, rename, or substitute another entry.
- **STATE-3**: A restored archive entry MUST be excluded from archive recall. Its archive origin and payload MUST remain preserved for integrity checks, and its current `restored` state MUST cause a repeated restore to return `ALREADY_RESTORED`.
- **VIS-1**: Active recall MUST consider only valid active topics referenced by the selected store indexes. Archive recall MUST consider only valid, current archived entries in the requested archive index. User trash and curation trash MUST never be searchable or injected.
- **VIS-2**: Recall success MUST expose metadata only. Active results contain `scope`, `slug`, `type`, `description`, and `score`. Archive results add `entry_id` and `archived_at`. Neither tool MUST expose a body, filesystem path, content hash, transaction data, or recovery artifact.
- **VIS-3**: Ranking MUST run locally at request time using BM25F over `slug`, `description`, and `body`, with deterministic tokenization including Korean character n-grams. Slug matches carry more weight than description matches, and description matches more than body matches. Results MUST be ordered deterministically by descending score, then global before project for equal scores, then slug by Unicode code point order. Recall MUST NOT call a model, inspect transcripts, mutate memory, or add results to the system prompt.
- **IO-1**: A recall query, after trimming, MUST be non-empty, well-formed Unicode, and at most 500 UTF-8 bytes. `limit` MUST be an integer from 1 through 10 and defaults to 5. A serialized recall response MUST be at most 25,000 UTF-8 bytes; matching results MUST be removed from the end until the response fits, with truncation reported.
- **IO-2**: The combined active corpus selected by one request, or the single-scope archive corpus selected by one request, MUST be bounded to 200 topics, 32 KiB per topic, and 512 KiB aggregate input. Lifecycle JSON files MUST be bounded to 64 KiB, and lifecycle directory listings MUST be bounded to 1,000 entries. A corpus that cannot be read completely within its limits MUST fail rather than return a partial search result.
- **IO-3**: Lifecycle and archive reads MUST reject malformed, inconsistent, symlinked, non-regular, or out-of-store artifacts. Records, indexes, current state, origin, topic metadata, byte length, and content digest MUST cross-validate. Integrity uncertainty MUST fail closed.
- **REC-1**: Lifecycle mutations MUST be serialized per store. Concurrent operations on different stores MAY proceed independently. A restore that finds the active slug occupied MUST return `ACTIVE_COLLISION`; it MUST NOT alter either copy.
- **REC-2**: Publication of a lifecycle entry or transaction bundle MUST be atomic at bundle visibility: readers observe a complete bundle or no bundle. Index and state replacement MUST be atomic within ordinary local filesystem semantics. This contract does not promise distributed locking or durability beyond those semantics.
- **REC-3**: Before a new lifecycle mutation, startup and request-time recovery MUST idempotently converge incomplete work to its committed result when integrity can be proven. Repeating recovery MUST not create another entry or change the selected payload. If convergence or cross-validation cannot be proven, only that store becomes recovery-blocked.

### Tool contracts

Tool argument schemas are validated before execution. A schema rejection, such as an unsafe slug, invalid enum, malformed UUID, empty or oversized query, or out-of-range limit, is reported by the OpenCode tool framework and is not one of the execution error JSON objects below.

All execution successes and failures use JSON in the tool output. Lifecycle tools operate on one entry per call.

#### `memory_archive(scope, slug)`

Moves the named active topic in the exact scope to the archive. Success is:

```json
{"ok":true,"code":"ARCHIVED","entry_id":"<uuid>","slug":"<slug>","scope":"global|project","source":"archive"}
```

#### `memory_delete(scope, slug)`

Moves the named active topic in the exact scope to user trash. Success is:

```json
{"ok":true,"code":"TRASHED","entry_id":"<uuid>","slug":"<slug>","scope":"global|project","source":"trash"}
```

#### `memory_restore(scope, source, entry_id)`

Restores the exact tuple, where `source` is `archive` or `trash`. The caller uses the `entry_id` returned by archive or delete. Success is:

```json
{"ok":true,"code":"RESTORED","entry_id":"<uuid>","slug":"<original-slug>","scope":"global|project","source":"archive|trash"}
```

#### `memory_recall(query, scope = "all", limit = 5)`

Searches the selected active corpus. Success is:

```json
{"ok":true,"query":"<trimmed-query>","scope":"all|global|project","matched_count":0,"result_count":0,"results_truncated":false,"results":[{"scope":"global|project","slug":"<slug>","type":"user|feedback|project|reference","description":"<description>","score":0.0}]}
```

`matched_count` is the number of positive-score matches before `limit` and output-size truncation. `result_count` is the returned array length. `results_truncated` is true whenever fewer results are returned than matched.

#### `memory_recall_archive(query, scope, limit = 5)`

Searches current canonical archive entries in one required scope. `archived_at` is the entry creation timestamp. Success is:

```json
{"ok":true,"query":"<trimmed-query>","scope":"global|project","matched_count":0,"result_count":0,"results_truncated":false,"results":[{"scope":"global|project","slug":"<slug>","type":"user|feedback|project|reference","description":"<description>","score":0.0,"entry_id":"<uuid>","archived_at":"<timestamp>"}]}
```

### Public execution errors

Every execution failure has the shape `{"ok":false,"error":"<CODE>"}`. The following matrix is exhaustive for public lifecycle and recall execution errors.

| Code | Tools | Meaning |
| --- | --- | --- |
| `SESSION_NOT_VERIFIED` | All five | The session is a child or could not be verified as primary. |
| `PROJECT_UNAVAILABLE` | All five when project is selected, and active recall with `all` | The project store is not available. No global fallback or partial `all` result is returned. |
| `STORE_UNAVAILABLE` | All five when global is selected, active recall with `all`, and unreadable recall corpora | The required global store or selected corpus cannot be read safely. |
| `RECOVERY_BLOCKED` | All five | The selected store has unresolved lifecycle or integrity state. |
| `CORPUS_LIMIT_EXCEEDED` | Both recall tools | A selected corpus exceeds a topic, byte, index, or bounded-read limit, so complete ranking is impossible. |
| `ACTIVE_NOT_FOUND` | `memory_archive`, `memory_delete` | The exact active slug is absent or is not a valid removable active topic. |
| `NOT_FOUND` | `memory_restore` | The exact `(scope, source, entry_id)` does not identify a restorable entry. |
| `ACTIVE_COLLISION` | `memory_restore` | The original slug already exists in active memory. Nothing is overwritten, merged, or renamed. |
| `ALREADY_RESTORED` | `memory_restore` | The exact entry's current state is already restored. |

### Acceptance scenarios

| Scenario | Expected observation | Requirements |
| --- | --- | --- |
| Archive, discover, restore | Archive returns `ARCHIVED`; active recall no longer sees the topic; archive recall returns metadata only; exact restore returns `RESTORED`; archive recall then excludes it. | AUTH-1, STATE-1..3, VIS-1..2 |
| Delete and restore | Delete returns `TRASHED`; neither recall tool sees the entry; restoring its trash tuple reproduces the original slug and payload without changing origin. | SCOPE-1, STATE-1..2, VIS-1 |
| Scope isolation | A project operation never reads global data; missing project returns `PROJECT_UNAVAILABLE`; blocked project does not prevent an explicit ready-global request; active `all` fails rather than returning global-only results. | SCOPE-1..3 |
| Authorization and validation | Child or unknown sessions receive `SESSION_NOT_VERIFIED`; malformed arguments are rejected by the schema rather than returned as execution error JSON; explicit-request wording is enforced by the agent contract, not provenance detection. | AUTH-1..2, IO-1 |
| Collision and repeat restore | Restore into an occupied slug returns `ACTIVE_COLLISION` without mutation; restoring an already restored tuple returns `ALREADY_RESTORED`; a wrong tuple returns `NOT_FOUND`. | STATE-2, REC-1 |
| Bounded, deterministic recall | The same corpus and query produce the same ranking and metadata fields; oversized or incomplete corpora fail; output fits 25,000 UTF-8 bytes and reports truncation. | VIS-2..3, IO-1..3 |
| Interrupted mutation | After interruption, recovery either converges once to the complete committed state or fences that store with `RECOVERY_BLOCKED`; no partial bundle becomes public and another healthy scope remains usable. | SCOPE-3, REC-2..3 |

### Change rules

Any runtime change that alters tool arguments, success fields, public errors, visibility, ranking order, limits, scope behavior, lifecycle transitions, or recovery outcomes requires this section to change in the same revision. New public execution errors require a matrix row and an acceptance scenario mapping. Implementation details may change without a README update only when every requirement and observable shape above remains true. Quit and restart OpenCode after changing tool registrations or plugin code so the new version is loaded.

## Automatic curation policy

Automatic apply is limited to a locally proven `duplicate-exact` `MERGE`. Semantic similarity, stale-content judgments, and every other non-exact proposal are report-only. Curation never hard-deletes memory files. Before an applied change, recoverable originals are archived under `.trash/<runId>/` in the relevant memory store.
For `duplicate-exact`, exact means equality of parsed `type`, `description`, and `body` after parser-defined surrounding-whitespace normalization, not byte identity; internal content differences remain unsafe, while raw SHA-256 hashes still fence stale or tampered sources.
Curator output is sparse: unchanged topics produce no `KEEP` operations. Valid non-exact operations are stored as metadata-only, namespace-local suggestions, deduplicated by operation content and source hashes, and up to three are consumed for the next verified primary-session injection. Delivery is best-effort and does not grant automatic semantic mutation authority.

## Architecture and dependency pin

See [`docs/architecture.html`](docs/architecture.html) for the system architecture and curation lifecycle.

`@opencode-ai/plugin` and the directly imported `@opencode-ai/sdk` intentionally remain pinned to `1.18.3` to preserve the verified behavior baseline. The installed OpenCode runtime may be newer; run `opencode --version` to inspect it. Coordinated dependency/runtime alignment is separate future work and must rerun the full suite and live config checks.
