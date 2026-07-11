# Agent Workflow

This repo configures a small agent stack. Keep each layer's job distinct.

## Layers

| Layer | Owns | Use when |
|---|---|---|
| Supacode | repos, worktrees, tabs, surfaces | You need workspace structure or multiple terminal surfaces. |
| Pi | coding-agent loop and tools | You are doing normal implementation, planning, research, or review. |
| Pi packages | reusable Pi behavior | The behavior is Pi-specific and should travel between projects. |
| Herdr | visible terminal agents | You need parallel/fresh-context agents whose transcripts and cost stay visible. |
| Shared skills | cross-harness workflow | The behavior should work in Pi, Claude Code, and other skill-aware agents. |

Default to the current Pi session. Add Herdr only when visible delegation is worth the overhead.

## Model selection

Use **roles** in prompts and skills:

- `research`
- `architecture`
- `planning`
- `delivery`
- `verification`

Concrete provider/model IDs live in config:

```text
home/.pi/agent/model-families.json
.pi/model-families.json
```

Do not bake concrete model names into shared skills or project workflow docs.

## Delegation

Use inline work for small or dependent tasks. Use visible Herdr workers for:

- broad independent research
- fresh-context review
- independent diagnosis hypotheses
- approved implementation in separate worktrees

Guardrails:

- default max workers: 2
- max workers without explicit override: 3
- read-only unless the user approved writes
- parallel writes require separate worktrees
- parent session summarizes worker output; do not paste full transcripts back in

## Harness routing

Use the local `harness-routing` skill when an upstream skill mentions background agents, subagents, model choice, or harness-specific behavior.

Translation rules:

- **Pi:** inline by default; Herdr visible workers only when justified; model roles via `pi-model-families` when available.
- **Claude Code:** use native Claude Code subagents/worktrees when justified; do not use Herdr just because it is installed.
- **Unknown/default:** stay sequential unless the runtime explicitly supports the feature.

## Publishing Pi packages

Reusable Pi behavior is staged under:

```text
home/.pi/packages/
```

Publish with Bun from `home/.pi`:

```bash
bun run pack:pi-packages
bun run publish:pi-model-families
bun run publish:pi-herdr-agents
```

After publishing, replace local package paths in settings with npm sources where appropriate.
