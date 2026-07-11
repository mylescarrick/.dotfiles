# Herdr Roles

| Role | Use for | Default mode |
|---|---|---|
| `researcher` | reading docs/code and gathering facts | read-only |
| `architect` | design review, seams, architecture risk | read-only |
| `planner` | plan critique or task breakdown review | read-only/docs-only |
| `reviewer` | fresh-context diff/plan/code review | read-only |
| `verifier` | checks, reproduction, validation | read-only plus shell checks |
| `executor` | implementation | write-capable only with approval/worktree |

Child prompts must include:

- role and mode
- exact scope
- whether writes are allowed
- expected output format
- "Do not spawn additional subagents"
- "Do not commit" unless explicitly approved

Read-only prompt sentence:

```text
Read-only mode: do not edit files, write files, run formatters, or commit. Return concise findings with paths and line references where useful.
```

Write-capable prompt sentence:

```text
Do not commit unless explicitly instructed. Keep changes scoped. Report files changed and verification evidence.
```
