# pi-herdr-agents

Pi package for visible Herdr-managed worker agents.

Pi intentionally does not include hidden subagents. This package keeps delegation explicit: every
worker is a real Pi process in a Herdr terminal, with its own transcript, model selection, and cost.

## Requirements

- `herdr` on `PATH`
- Pi on `PATH`
- Recommended: `herdr integration install pi`

If Herdr is missing or no Herdr server is running, the extension reports that clearly. Start commands
will attempt to start a local Herdr server before launching workers.

## Commands

```text
/herdr-status
/herdr-start <role> [--name <name>] [--family <family>] [--cwd <path>] [--write] -- <prompt>
/herdr-read <agent-name-or-id> [--lines N]
/herdr-wait <agent-name-or-id> [--state done|idle|blocked|working|unknown] [--timeout-ms N]
/herdr-send <agent-name-or-id> -- <text>
```

Roles: `researcher`, `architect`, `planner`, `executor`, `reviewer`, `verifier`.

Most roles start read-only child Pi instances. `executor --write` intentionally leaves normal Pi tools
available; use that only after explicit approval, and prefer worktrees for parallel writes.

## Skill

Use `/skill:herdr-agents` in Pi to load delegation policy and prompt templates.
