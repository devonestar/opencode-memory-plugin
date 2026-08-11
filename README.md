# OpenCode Memory Plugin

This private OpenCode plugin injects durable memory into sessions, exposes the `memory_save` tool, keeps global and project memories separate, and provides bounded curation workflows. The plugin entry point is `src/index.ts`; it intentionally exports only a default plugin factory because OpenCode invokes every exported function as a plugin.

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
  "/absolute/path/to/opencode-memory-plugin/src/index.ts",
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
REPO="/absolute/path/to/opencode-memory-plugin"
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

## Memory recall

`memory_recall` searches approved durable memories with local, request-time BM25F ranking. It searches `slug`, `description`, and `body`, including deterministic Korean character n-grams, but returns only `scope`, `slug`, `type`, `description`, and score metadata. It does not call a model, expose memory bodies, search transcripts, mutate memory, or add recall results to the system prompt.

The tool requires a verified primary session. Its `scope` is `all`, `global`, or `project`; project-dependent requests fail when the project store is unavailable rather than falling back to global memory. Results come only from valid topic files referenced by the selected stores' bounded `MEMORY.md` indexes. Restart OpenCode after updating the plugin so the new tool registration is loaded.

## Automatic curation policy

Automatic apply is limited to a locally proven `duplicate-exact` `MERGE`. Semantic similarity, stale-content judgments, and every other non-exact proposal are report-only. Curation never hard-deletes memory files. Before an applied change, recoverable originals are archived under `.trash/<runId>/` in the relevant memory store.
For `duplicate-exact`, exact means equality of parsed `type`, `description`, and `body` after parser-defined surrounding-whitespace normalization, not byte identity; internal content differences remain unsafe, while raw SHA-256 hashes still fence stale or tampered sources.

## Architecture and dependency pin

See [`docs/architecture.html`](docs/architecture.html) for the system architecture and curation lifecycle.

`@opencode-ai/plugin` and the directly imported `@opencode-ai/sdk` intentionally remain pinned to `1.18.3` to preserve the verified behavior baseline. The installed OpenCode runtime may be newer; run `opencode --version` to inspect it. Coordinated dependency/runtime alignment is separate future work and must rerun the full suite and live config checks.
