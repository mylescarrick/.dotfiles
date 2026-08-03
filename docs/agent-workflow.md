# Agent Workflow

This repo configures a small agent stack. Keep each layer's job distinct.

## Layers

| Layer | Owns | Use when |
|---|---|---|
| Herdr | repos, worktrees, tabs, surfaces, agent state | You need workspace structure or multiple terminal surfaces. Preferred. |
| Supacode | the same, incumbent | Still fine; being migrated away from. See `docs/herdr-sprites.md`. |
| Sprites | remote persistent execution | Work should outlive the laptop, or needs isolation from it. Optional. |
| Pi | coding-agent loop and tools | You are doing normal implementation, planning, research, or review. |
| Pi packages | reusable Pi behavior | The behavior is Pi-specific and should travel between projects. |
| Pi tidy subagents | foreground/background child Pi agents | You need justified parallel or fresh-context work inside a Pi session. |
| Shared skills | cross-harness workflow | The behavior should work in Pi, Claude Code, and other skill-aware agents. |

Default to the current Pi session. Add tidy subagents only when delegation is worth the overhead and safety constraints.

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

Use inline work for small or dependent tasks. Use Pi tidy subagents for:

- broad independent research
- fresh-context review
- independent diagnosis hypotheses
- approved implementation in separate worktrees

Guardrails:

- inline remains the default
- prefer foreground children when the parent needs the result before proceeding
- use background children for longer independent work that can report back later
- read-only unless the user approved writes
- parallel writes require separate worktrees and non-overlapping scopes
- parent session summarizes child output; use artifacts for full details

## Surfaces and remote execution

Herdr is the workspace/agent multiplexer: `herdr worktree create|open|remove` owns
worktrees, and `herdr-plus` worktree auto-layouts start each worktree's tabs with their
commands already running. `pi` is a first-class Herdr agent kind, so pane state
(`idle`/`working`/`blocked`/`done`) is real, not inferred — install the hook path with
`herdr integration install pi`.

Fly.io Sprites are optional remote sandboxes: persistent Linux boxes that hibernate when
idle. One sprite per repo, many worktrees inside it. Manage them with `sprite-dev`.

Full rationale, topology trade-offs, auth handling, and the config this repo tracks are in
`docs/herdr-sprites.md`.

## Harness routing

Use the local `harness-routing` skill when an upstream skill mentions background agents, subagents, model choice, or harness-specific behavior.

Translation rules:

- **Pi:** inline by default; tidy subagents only when justified; model roles via `pi-model-families` when available.
- **Claude Code:** use native Claude Code subagents/worktrees when justified.
- **Unknown/default:** stay sequential unless the runtime explicitly supports the feature.

## Publishing Pi packages

Reusable local Pi behavior is staged under:

```text
home/.pi/packages/
```

Publish with Bun from `home/.pi`:

```bash
bun run pack:pi-packages
bun run publish:pi-model-families
```

Published third-party Pi packages such as `@mobrienv/pi-tidy-tools` and `@mobrienv/pi-tidy-subagents` are managed through `config/pi/settings.defaults.json` and Pi's package updater.
