---
name: herdr-agents
description: Use Herdr to run visible Pi worker agents for bounded research, review, verification, or approved worktree execution. Use in Pi when the user asks for Herdr, parallel agents, subagents, delegation, or fresh-context review.
---

# Herdr Agents

Use this skill **only when the active harness is Pi**. Do **not** use this skill from Claude Code or other harnesses, even if `herdr` or `pi` exists on PATH.

Herdr delegation is for visible worker agents: every delegated worker must be a real terminal agent managed by Herdr, with its own transcript, model selection, and cost. Do not create hidden subagents.

## Availability

1. Check whether the Pi extension commands/tools are available:
   - `/herdr-status`
   - `herdr_available`
   - `herdr_start_agent`
   - `herdr_read_agent`
   - `herdr_wait_agent`
   - `herdr_send_agent`
2. If they are unavailable, continue inline/sequentially and say Herdr orchestration is unavailable.
3. If Herdr is installed but the server is not running, the extension may start a local server before launching workers.

Recommended one-time setup outside the agent:

```bash
brew install herdr
herdr integration install pi
```

## When to use Herdr

Use Herdr when one of these is true:

- The user explicitly asks for Herdr, visible agents, subagents, parallel agents, or delegation.
- Broad planning/research spans independent areas.
- A fresh-context review is valuable.
- Independent hypothesis checks can run read-only.
- Independent implementation tasks can run in separate worktrees and the user approved that mode.

Do **not** use Herdr for:

- Simple one-file or one-task implementation.
- Backlog browsing or routine plan/PRD edits.
- Dependent tasks that touch the same files.
- Any flow in Claude Code.
- Any flow where Herdr is absent and the extension cannot launch workers.

## Roles

| Role | Use for | Default mode |
|---|---|---|
| `researcher` | reading docs/code and gathering facts | read-only |
| `architect` | design review, seams, architecture risk | read-only |
| `planner` | plan critique or task breakdown review | read-only/docs-only |
| `reviewer` | fresh-context diff/plan/code review | read-only |
| `verifier` | checks, reproduction, validation | read-only plus shell checks |
| `executor` | implementation | write-capable only with approval/worktree |

## Preflight

Before launching more than one worker, show a concise launch table.

If the user explicitly requested automatic delegation, show the table and proceed. Otherwise ask for confirmation.

```text
Launching visible Herdr agents:

| Agent | Role | Mode | Writes? | Task |
|---|---|---|---|---|
| researcher-auth | researcher | read-only | no | Map auth routes and summarize seams |
| reviewer-plan | reviewer | read-only | no | Review active PRD risk and task order |
```

Defaults:

- Default max workers: 2.
- Max workers without explicit override: 3.
- Workers are read-only unless the user explicitly approved writes.
- Parallel write-capable workers require separate worktrees.

## Launch examples

Start one read-only researcher:

```text
/herdr-start researcher --name researcher-auth -- Read the auth flow and summarize the main files, invariants, and open questions. Do not edit.
```

Start a verifier that can run shell checks but should not edit:

```text
/herdr-start verifier --name verifier-tests -- Reproduce the failing test and report the smallest command plus failure details. Do not edit.
```

Start a write-capable executor only after explicit approval, preferably inside a separate worktree:

```text
/herdr-start executor --name executor-task-1 --cwd /path/to/worktree --write -- Implement task 1. Do not commit unless explicitly instructed.
```

Read results:

```text
/herdr-read researcher-auth --lines 120
/herdr-wait researcher-auth --state idle --timeout-ms 120000
```

## Child prompt requirements

Every child task should include:

- role and mode
- whether writes are allowed
- exact scope
- output format
- "Do not spawn additional subagents"
- "Do not commit" unless explicitly approved

For read-only workers, include:

```text
Read-only mode: do not edit files, write files, run formatters, or commit. Return concise findings with paths and line references where useful.
```

For write-capable workers, include:

```text
Do not commit unless explicitly instructed. Keep changes scoped. Report files changed and verification evidence.
```

## Synthesis

After workers finish:

1. Read only the recent relevant output.
2. Summarize findings in the parent session.
3. Do not paste full transcripts into the parent context.
4. If a worker is blocked, report the blocker and decide whether to answer it, stop it, or continue inline.

## Fallback

If Herdr is unavailable or launch fails, do not retry repeatedly. Continue inline/sequentially and mention the fallback.
