# Agent Workflow

This repo configures a small agent stack. Keep each layer's job distinct.

## Layers

| Layer | Owns | Use when |
|---|---|---|
| Supacode | repos, worktrees, tabs, surfaces | You need workspace structure or multiple terminal surfaces. |
| Pi | coding-agent loop and tools | You are doing normal implementation, planning, research, or review. |
| Pi packages | reusable Pi behavior | The behavior is Pi-specific and should travel between projects. |
| Pi tidy subagents | foreground/background child Pi agents | You need justified parallel or fresh-context work inside a Pi session. |
| Shared skills | cross-harness workflow | The behavior should work in Pi, Claude Code, and other skill-aware agents. |

Default to the current Pi session. Add tidy subagents only when delegation is worth the overhead and safety constraints.

## Model selection

Use Pi's built-in `/model` and `/thinking` controls deliberately. Keep concrete provider/model IDs out of shared skills and project workflow docs.

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

## Harness routing

Use the local `harness-routing` skill when an upstream skill mentions background agents, subagents, model choice, or harness-specific behavior.

Translation rules:

- **Pi:** inline by default; tidy subagents only when justified; choose model and thinking deliberately with Pi's built-in controls.
- **Claude Code:** use native Claude Code subagents/worktrees when justified.
- **Unknown/default:** stay sequential unless the runtime explicitly supports the feature.

## Pi packages

Published third-party Pi packages such as `@mobrienv/pi-tidy-tools` and `@mobrienv/pi-tidy-subagents` are managed through `config/pi/settings.defaults.json` and Pi's package updater.
