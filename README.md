# OpenCode Memory Plugin

This private OpenCode plugin injects durable memory into sessions, exposes the `memory_save` tool, keeps global and project memories separate, and provides bounded curation workflows. The plugin entry point is `src/index.ts`; it intentionally exports only a default plugin factory because OpenCode invokes every exported function as a plugin.

## Memory data and scopes

Memory data is not stored in this repository. The runtime resolves the OpenCode config root from `XDG_CONFIG_HOME`, falling back to `~/.config`, and writes to these live locations:

| Scope | On-disk path | Intended content |
| --- | --- | --- |
| Global | `~/.config/opencode/memory/` | Person-level preferences, organization-wide systems, and workflows that apply across workspaces |
| Project | `~/.config/opencode/memory/projects/<namespace>/` | Repository, product, or codebase-specific facts |

Do not move, copy into Git, or rewrite the live `~/.config/opencode/memory/` tree when maintaining this repository.

## OpenCode wiring

The global config at `~/.config/opencode/opencode.jsonc` loads this repository by absolute path. Keep the plugin order and curation values unchanged unless a separate behavior change is intended:

```jsonc
[
  "/Users/devvy/sandbox/opencode-memory-plugin/src/index.ts",
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

The files under `opencode/` are the single editable copies of the memory-specific OpenCode assets:

- `opencode/agent/memory-curator.md`
- `opencode/command/memory-review.md`
- `opencode/command/memory-curation-status.md`
- `opencode/command/memory-curation-run.md`
- `opencode/command/memory-curation-pause.md`
- `opencode/command/memory-curation-resume.md`
- `opencode/skills/memory-types/SKILL.md`

Their standard discovery locations under `~/.config/opencode/{agent,command,skills}/` are absolute symlinks into this repository. OpenCode has been verified to follow those symlinks with `opencode debug config` and `opencode debug skill`. If the repository moves, recreate the symlinks with the new absolute target paths before restarting OpenCode. Do not edit through a copied second tree.

## Development

Install the repository-local dependencies and run the quality gates with Bun:

```sh
bun install
bun test
bunx tsc --noEmit -p tsconfig.json
bun run check
```

`bun run check` runs typechecking and the complete test suite. Some production-stack tests intentionally inspect the live OpenCode config, agent, and command assets.

## Automatic curation policy

Automatic apply is limited to a locally proven `duplicate-exact` `MERGE`. Semantic similarity, stale-content judgments, and every other non-exact proposal are report-only. Curation never hard-deletes memory files. Before an applied change, recoverable originals are archived under `.trash/<runId>/` in the relevant memory store.

## Architecture and dependency pin

See [`docs/architecture.html`](docs/architecture.html) for the system architecture and curation lifecycle.

`@opencode-ai/plugin` and the directly imported `@opencode-ai/sdk` are pinned to `1.18.3` to preserve the verified behavior baseline. The OpenCode runtime is currently `1.18.5`. A coordinated dependency upgrade to `1.18.5` can be evaluated as future work, with the full suite and live config checks rerun, but it is intentionally outside this extraction.
