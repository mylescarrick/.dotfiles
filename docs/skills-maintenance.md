# Skills Maintenance

Use the `writing-great-skills` vocabulary when adding or editing skills: predictability, context load, cognitive load, branches, completion criteria, progressive disclosure, and pruning.

## Ownership

| Skill type | Location | Rule |
|---|---|---|
| Vendored skills | `home/.agents/skills/*` tracked in `.skill-lock.json` | Do not edit in place. Update/remove with `dot skills`. |
| Local shared skills | `home/.agents/skills/*` not in `.skill-lock.json` | Keep small, harness-aware, and cross-agent. |
| Pi-only skills | `home/.pi/packages/*/skills/*` | Keep Pi-specific behavior out of Claude Code. |
| Project skills | project `.agents/skills/*` or `.pi/skills/*` | Keep project vocabulary and workflow here. |

Vendored Matt Pocock skills are upstream-owned. When they mention subagents or background agents, use the local `harness-routing` overlay instead of editing them. If upstream removes or deprecates a skill, remove it with `dot skills remove <name>` and then `dot skills sync`.

Current audit note: `grill-me`, `grill-with-docs`, and `grilling` are all still intentionally installed because upstream `ask-matt` references them as distinct branches/wrappers.

## Invocation policy

Use model-invoked skills only when the agent must discover the skill by itself or another skill must reach it. Otherwise prefer user-invoked skills with `disable-model-invocation: true`.

Description rules for model-invoked skills:

- front-load the leading word
- list distinct triggers, not synonyms
- keep the description short enough to earn its context load
- avoid implementation detail that belongs in the body

## Body shape

A good `SKILL.md` should usually contain:

1. the harness gate, if any
2. the minimal decision loop
3. ordered steps with checkable completion criteria
4. pointers to references for command details, examples, and long tables

Move reference-heavy material to sibling files when it is branch-specific or rarely needed.

## Harness policy

Any skill mentioning subagents, background agents, worktrees, MCP, model selection, or hooks must be harness-aware.

Preferred wording:

- Pi: inline by default; use `@mobrienv/pi-tidy-subagents` only when delegation is justified and available.
- Claude Code: native subagents/worktrees only when justified.
- Model choice: use roles (`research`, `architecture`, `planning`, `delivery`, `verification`), not concrete model IDs.

## Pruning checklist

Before committing skill changes:

- Does every sentence change behavior?
- Is each concept defined in one place?
- Is any branch hidden behind a clear reference pointer?
- Are completion criteria observable?
- Are vendored skills untouched?
- Are Pi-only behaviors kept in Pi packages or behind Pi-only gates?
