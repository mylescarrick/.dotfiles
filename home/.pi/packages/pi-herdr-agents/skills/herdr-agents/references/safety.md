# Herdr Safety

Use Herdr when one of these is true:

- user explicitly asks for Herdr, visible agents, subagents, parallel agents, or delegation
- broad planning/research spans independent areas
- fresh-context review is valuable
- independent hypothesis checks can run read-only
- independent implementation tasks can run in separate worktrees and the user approved that mode

Do not use Herdr for:

- simple one-file or one-task implementation
- backlog browsing or routine plan/PRD edits
- dependent tasks that touch the same files
- any flow in Claude Code
- any flow where Herdr is absent and the extension cannot launch workers

Defaults:

- default max workers: 2
- max workers without explicit override: 3
- read-only unless the user explicitly approved writes
- parallel write-capable workers require separate worktrees

Before launching more than one worker, show:

```text
Launching visible Herdr agents:

| Agent | Role | Mode | Writes? | Task |
|---|---|---|---|---|
| researcher-auth | researcher | read-only | no | Map auth routes and summarize seams |
| reviewer-plan | reviewer | read-only | no | Review active PRD risk and task order |
```

After workers finish:

1. Read only the recent relevant output.
2. Summarize findings in the parent session.
3. Do not paste full transcripts into the parent context.
4. If a worker is blocked, report the blocker and decide whether to answer it, stop it, or continue inline.
