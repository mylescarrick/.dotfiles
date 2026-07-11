---
name: herdr-agents
description: Visible Herdr delegation for Pi. Use in Pi when the user asks for Herdr, subagents, parallel agents, delegation, fresh-context review, or independent worker agents.
---

# Herdr Agents

Use this skill **only when the active harness is Pi**. Do not use it from Claude Code or other harnesses, even if `herdr` or `pi` exists on PATH.

Herdr delegation means every worker is a visible Herdr-managed Pi process with its own terminal, transcript, model selection, and cost. Do not create hidden subagents.

## Loop

1. **Check availability.** Use `/herdr-status` or `herdr_available`. If unavailable, continue inline and say Herdr orchestration is unavailable.
2. **Decide inline vs visible delegation.** Inline is default. Use [safety](references/safety.md) only when the task clears the delegation threshold.
3. **Choose roles.** Pick from `researcher`, `architect`, `planner`, `reviewer`, `verifier`, `executor`; see [roles](references/roles.md).
4. **Preflight multi-agent launches.** Show the launch table from [safety](references/safety.md). Proceed without a question only if the user explicitly requested automatic delegation.
5. **Launch bounded workers.** Use [commands](references/commands.md). Default to read-only. Use `executor --write` only after explicit approval and preferably in a worktree.
6. **Synthesize.** Read recent output, summarize conclusions, and avoid pasting full transcripts into the parent context.

Completion criterion: either visible workers are launched with bounded prompts, or the parent session explicitly continues inline because Herdr is unavailable or not worth the overhead.
