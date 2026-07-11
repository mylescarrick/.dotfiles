---
name: harness-routing
description: Use when choosing workflow/tooling across Pi, Claude Code, Supacode, Herdr, model roles, delegation, or when an upstream skill mentions subagents/background agents.
---

# Harness Routing

Route the work to the lowest-overhead visible workflow. This skill is a local overlay for shared/upstream skills; do not edit vendored skills just to add harness policy.

## Routing rules

1. **Identify the active harness.** Do not infer Pi from `command -v pi`; use the actual conversation/runtime context.
2. **Choose the surface.** Use Supacode for repo/worktree/tab organization. Use Herdr only for visible multi-agent terminal orchestration. Use the current agent session for normal single-threaded work.
3. **Choose the model level by role.** Say `research`, `architecture`, `planning`, `delivery`, or `verification`; concrete model IDs belong in config such as `model-families.json`, not in skills.
4. **Choose delegation only when it pays.** Inline is default. Delegate for broad independent research, fresh-context review, independent hypothesis checks, or approved worktree execution.

## Harness modes

- **Pi:** use `pi-model-families` for model roles when available. Use `pi-herdr-agents` for visible Herdr workers only when delegation clears the threshold. If unavailable, continue inline.
- **Claude Code:** use native Claude Code subagents/worktrees when appropriate. Do not use Herdr just because it is installed.
- **Other/default:** avoid harness-specific features unless the current runtime explicitly supports them.

## Upstream skill overlay

If a vendored skill says “background agent”, “subagent”, or “parallel agents”, translate that through the current harness:

- Pi → inline by default; Herdr visible workers only when justified.
- Claude Code → native subagents/worktrees when justified.
- Unknown → sequential inline unless the user explicitly approves another mechanism.

Completion criterion: the next action names the selected harness path, or explicitly says no special routing is needed.
