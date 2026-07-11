# Pi Herdr Agents + Model Families Spec

Status: draft implementation spec
Owner repo: dotfiles
Target consumers: global Pi, Knoxi Apps, any Pi project that wants visible delegation
Created: 2026-07-11

## Goal

Replace Knox-specific model routing and ad-hoc subagent guidance with two reusable Pi packages:

1. **`pi-model-families`** — role-based model defaults and switching for Pi.
2. **`pi-herdr-agents`** — visible, bounded Pi delegation through Herdr-managed terminal agents.

Knoxi should consume these packages like any other Pi project. Knox skills should become model-agnostic and Pi-harness-gated rather than depending on `/knox-model` or project-local router commands.

## Non-goals

- Do not add hidden subagents to Pi.
- Do not spawn background workers whose cost/transcripts are invisible to the user.
- Do not make Claude Code use Herdr. Claude Code keeps its own native subagent/worktree guidance.
- Do not make Knox skills depend on concrete model IDs.
- Do not require Herdr for normal small/medium Pi tasks.

## Design principles

- **Visible delegation:** every delegated agent is a real terminal agent in Herdr.
- **Small interface, deep implementation:** skills should request high-level roles; extensions handle CLI details, IDs, quoting, status, and truncation.
- **Harness-gated behavior:** Herdr orchestration is Pi-only. Skills must not infer Pi from `command -v pi`.
- **Bounded parallelism:** default max 2 agents; max 3 without explicit override; write-capable agents require approval and usually worktrees.
- **Project override without project code:** teams customize JSON config, not extension source.
- **Graceful fallback:** if Herdr or package commands are absent, continue inline/sequentially.

## Package 1: `pi-model-families`

### Purpose

Expose model defaults by **role**, not by project-specific command names.

Roles:

- `research`
- `architecture`
- `planning`
- `delivery`
- `verification`

### Interface

Commands:

```text
/model-family                 # show status
/model-family list            # list families
/model-family use <family>    # set active family, resume auto routing
/model-family default         # switch to defaultFamily
/model-family role <role>     # queue/apply role for next turn
/model-family <role> [prompt] # shorthand; optionally send prompt
/model-family lock            # keep manually selected model
/model-family reload          # reload config
/mf ...                       # alias
```

Config files:

```text
~/.pi/agent/model-families.json       # global
.pi/model-families.json               # trusted project override
```

Config shape:

```json
{
  "defaultFamily": "copilot-budget",
  "autoRoute": true,
  "returnRole": "delivery",
  "families": {
    "family-name": {
      "description": "Human-readable purpose",
      "roles": {
        "planning": {
          "provider": "github-copilot",
          "model": "gpt-5.5",
          "thinkingLevel": "high"
        },
        "delivery": {
          "provider": "github-copilot",
          "model": "mai-code-1-flash-picker",
          "thinkingLevel": "low"
        }
      }
    }
  }
}
```

Merge order:

1. built-in safe fallback
2. global config
3. project config, only when trusted

Role fallbacks:

- `research` → `architecture` → `planning` → `delivery`
- `architecture` → `planning` → `research` → `delivery`
- `planning` → `architecture` → `research` → `delivery`
- `delivery` → `verification` → `planning`
- `verification` → `delivery`

### Behavior

- In auto mode, classify user prompt into one role before the agent starts.
- Switch model/thinking at turn boundaries using Pi extension APIs.
- After elevated roles (`research`, `architecture`, `planning`, `verification` when configured that way), return to `returnRole` after the agent turn.
- Manual `/model` or model cycling locks routing until `/model-family auto` or `/model-family use <family>`.
- Missing model/API key should warn and leave current model unchanged.

### Packaging

Repository/package layout:

```text
pi-model-families/
├── package.json
├── README.md
├── extensions/
│   └── model-families/
│       ├── index.ts
│       ├── package.json
│       └── tsconfig.json
└── examples/
    └── model-families.json
```

`package.json`:

```json
{
  "name": "pi-model-families",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/model-families"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

### Dotfiles development state

The current dotfiles extension at `home/.pi/agent/extensions/model-families/` is the local prototype. Work backwards by extracting this into package form, then loading it as a package instead of relying on a top-level global extension.

## Package 2: `pi-herdr-agents`

### Purpose

Provide Pi-only visible delegation through Herdr.

This package combines:

- a Pi extension that handles deterministic Herdr CLI mechanics
- a Pi skill that teaches when and how to delegate safely

### Interface: extension commands

Initial minimal commands:

```text
/herdr-status
/herdr-start <role> [--name <name>] [--family <family>] [--cwd <path>] -- <prompt>
/herdr-read <agent-name-or-id> [--lines N]
/herdr-wait <agent-name-or-id> [--state done|idle|blocked] [--timeout SEC]
/herdr-send <agent-name-or-id> -- <text>
```

Later command:

```text
/herdr-delegate
```

`/herdr-delegate` should accept a short markdown delegation plan and launch several agents after showing a launch table.

### Interface: extension tools

Expose tools so the model can operate Herdr without brittle shell quoting:

```text
herdr_available
herdr_start_agent
herdr_read_agent
herdr_wait_agent
herdr_send_agent
```

Tool responsibilities:

- detect Herdr presence and version
- validate Herdr command availability against the installed binary
- start visible agents in the current repo/cwd
- name agents predictably
- pass prompt safely
- optionally resolve model-family role to explicit Pi CLI flags
- read recent output with truncation
- report useful IDs/names back to Pi

### Agent roles

Generic Herdr roles map to model-family roles:

| Herdr role | Model-family role | Default mode |
|---|---|---|
| `researcher` | `research` | read-only |
| `architect` | `architecture` | read-only |
| `planner` | `planning` | read-only / docs-only |
| `executor` | `delivery` | write-capable only with approval/worktree |
| `reviewer` | `verification` | read-only |
| `verifier` | `verification` | read-only unless running checks |

### Spawn policy

Default child command should be Pi, not Claude Code:

```sh
pi --name "<agent-name>" --provider <provider> --model <model> --thinking <level> "<prompt>"
```

If model-family resolution is unavailable, omit model flags and let child Pi use its defaults.

### Safety rules

- Do not spawn write-capable agents unless user explicitly approved writes.
- Do not run multiple write-capable agents in the same checkout.
- For parallel implementation, use separate worktrees or stop and ask.
- Read-only agents must be told: "Do not edit files. Do not commit. Return concise findings."
- Executor agents must be told: "Do not commit" unless running in approved worktree mode.
- Parent must summarize child outputs; do not paste large transcripts into the parent.

### Skill: `herdr-agents`

Package-local Pi skill path:

```text
skills/herdr-agents/SKILL.md
```

Important: do **not** put this in shared `~/.agents/skills` by default. It is a Pi package skill so Claude Code does not auto-discover it.

Skill frontmatter:

```yaml
---
name: herdr-agents
description: Use Herdr to run visible Pi worker agents for bounded research, review, verification, or approved worktree execution. Use in Pi when the user asks for Herdr, parallel agents, subagents, delegation, or fresh-context review.
---
```

Skill body must start with a hard gate:

```markdown
Use this skill only when the active harness is Pi. Do not use this skill from Claude Code or other harnesses, even if `herdr` or `pi` exists on PATH.
```

Decision matrix:

Use Herdr when:

- user explicitly asks for Herdr / visible agents / subagents / parallel delegation
- broad planning research spans independent areas
- a fresh-context review is valuable
- independent hypothesis checks can run read-only
- independent PRD tasks can be executed in separate worktrees and user approved that mode

Do not use Herdr when:

- simple one-file or one-task implementation
- backlog browsing or routine PRD edits
- dependent tasks touch the same files
- active harness is Claude Code
- Herdr is missing or extension commands are unavailable

Preflight for multiple agents:

```text
Launching visible Herdr agents:

| Agent | Role | Model family/role | Mode | Writes? |
|---|---|---|---|---|
| researcher-auth | researcher | active/research | read-only | no |
| reviewer-plan | reviewer | active/verification | read-only | no |
```

If user explicitly requested automatic delegation, show the table and proceed. Otherwise ask for confirmation.

### Packaging

Repository/package layout:

```text
pi-herdr-agents/
├── package.json
├── README.md
├── extensions/
│   └── herdr-orchestrator/
│       ├── index.ts
│       ├── herdr-cli.ts
│       ├── prompts.ts
│       ├── package.json
│       └── tsconfig.json
└── skills/
    └── herdr-agents/
        └── SKILL.md
```

`package.json`:

```json
{
  "name": "pi-herdr-agents",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/herdr-orchestrator"],
    "skills": ["./skills/herdr-agents"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

## Knoxi migration

### Remove project-local model router

Remove from Knoxi:

```text
.pi/extensions/knox-model-router/
.pi/knox-model-router.json
```

Remove command references:

- `/knox-model`
- `/escalate`
- `/deescalate`
- router-provided `/knox-plan` / `/knox-build` aliases

Remove or rewrite docs that mention concrete model defaults:

```text
.agents/skills/references/pi-model-routing.md
```

Replace with a model-agnostic Pi harness reference, e.g.:

```text
.agents/skills/references/pi-harness.md
```

Contents should explain:

- model-family roles, not model names
- Herdr visible delegation availability
- Pi-only gating
- fallback to inline sequential work

### Update Knox skills

Patch:

```text
.agents/skills/knox-plan/SKILL.md
.agents/skills/knox-build/SKILL.md
```

Remove references like:

- Knox model router
- GPT-5.4-mini / GPT-5.5 / Sonnet / Kimi model names
- `/knox-model`
- `/escalate`

Add Pi-only sections.

#### `knox-plan` replacement wording

```markdown
### Pi model roles and Herdr delegation

Only use this section when the active harness is Pi. Do not use Herdr from Claude Code.

If `pi-model-families` is available, planning/design work should use the `planning` or `architecture` role and normal follow-up work should return to `delivery`.

If `pi-herdr-agents` is available and the plan needs broad independent research, use visible read-only Herdr agents. Keep the default path inline for backlog browsing, routine PRD edits, and small designs.
```

#### `knox-build` replacement wording

```markdown
### Pi model roles and Herdr delegation

Only use this section when the active harness is Pi. Do not use Herdr from Claude Code.

If `pi-model-families` is available, normal implementation should use `delivery`; broad refactor/design/security review should use `architecture` or `verification`.

If `pi-herdr-agents` is available, use visible Herdr agents for fresh-context review, broad read-only investigation, or independent worktree executors. Do not run parallel write-capable agents in the same checkout.
```

### Knoxi package config

While unpublished:

```json
{
  "packages": [
    "git:github.com/<owner>/pi-model-families",
    "git:github.com/<owner>/pi-herdr-agents"
  ]
}
```

After npm publishing:

```json
{
  "packages": [
    "npm:pi-model-families",
    "npm:pi-herdr-agents"
  ]
}
```

Optional Knoxi project override:

```text
.pi/model-families.json
```

This file may name preferred families and concrete models. Knox skills should still not mention those models.

## Dotfiles integration

### Packages

Add Herdr to Brewfile:

```ruby
brew "herdr"
```

Global Pi settings should eventually load package sources rather than top-level local extension copies:

```json
{
  "packages": [
    "npm:pi-claude-bridge",
    "npm:pine-of-glass",
    "git:github.com/<owner>/pi-model-families",
    "git:github.com/<owner>/pi-herdr-agents"
  ]
}
```

### Herdr config

Optionally track:

```text
home/.config/herdr/config.toml
```

Initial config can be minimal:

```toml
onboarding = false

[theme]
name = "catppuccin"

[ui]
agent_panel_sort = "priority"

[ui.toast]
delivery = "herdr"
delay_seconds = 1
```

Runtime files remain ignored by existing `.gitignore` rules.

### Pi integration

Herdr installs the Pi integration to:

```text
~/.pi/agent/extensions/herdr-agent-state.ts
```

For dotfiles, decide whether this file is:

1. installed by a `dot` helper/doctor command, or
2. tracked directly after install.

Preferred: install/verify via `dot doctor` or `dot init`, because Herdr owns the integration file.

## Implementation phases

### Phase 0 — Spec and CLI verification

- Write this spec.
- Install Herdr if missing.
- Run `herdr --help`, `herdr agent --help`, `herdr pane --help`, and `herdr integration --help`.
- Record exact command shapes in `docs/herdr-cli-notes.md` before implementing the extension.

### Phase 1 — Package extraction: model families

- Move current `home/.pi/agent/extensions/model-families` prototype into package layout.
- Keep dotfiles config at `home/.pi/agent/model-families.json`.
- Load package via Pi settings.
- Verify `/model-family status` in Pi.
- Add smoke/type checks.

### Phase 2 — Herdr package MVP

- Add `pi-herdr-agents` package.
- Implement `herdr_available`, `/herdr-status`.
- Implement `/herdr-start` for one read-only Pi child agent.
- Implement `/herdr-read` with truncation.
- Add `herdr-agents` skill.
- Verify manually in a test repo.

### Phase 3 — Safe delegation loop

- Add wait/send support.
- Add role-to-model-family resolution when `pi-model-families` config exists.
- Add launch table behavior to skill.
- Add max-agent guardrails.

### Phase 4 — Knoxi migration

- Update Knox skills/references.
- Remove Knox model router.
- Add package dependencies to Knoxi `.pi/settings.json`.
- Add Knoxi `.pi/model-families.json` if project-specific defaults are needed.
- Verify `/skill:knox-plan` and `/skill:knox-build` in Pi still choose inline paths for small tasks.
- Verify Claude Code does not pick up `herdr-agents` and Knox skills tell Claude Code not to use Herdr.

### Phase 5 — Publish

- Publish packages or pin git refs.
- Update dotfiles global settings to package sources.
- Update docs with install/upgrade instructions.

## Acceptance criteria

### Generic Pi

- In a non-Knox repo, Pi can load `pi-herdr-agents` and explicitly run `/skill:herdr-agents`.
- If Herdr is absent, the skill falls back without failure.
- If Herdr is present, `/herdr-start researcher -- <prompt>` launches a visible Pi child agent.
- Parent can read child output without dumping unbounded transcript into context.

### Model families

- Global model-family config loads.
- Trusted project config overrides global config.
- `/model-family use <family>` switches role defaults.
- Manual `/model` locks routing.
- Missing model warns and does not crash.

### Knoxi

- No `knox-model-router` extension remains.
- Knox skills contain no concrete model IDs.
- Knox skills mention Herdr only inside Pi-only sections.
- Claude Code path remains native Claude Code subagents/worktrees, not Herdr.
- Pi path uses Herdr only when delegation threshold is met.

### Cost/visibility

- No delegated agent is hidden from Herdr.
- Multi-agent launch shows a launch table before or at launch time.
- Default maximum agents is 2.
- Write-capable parallel work requires worktrees or explicit stop/approval.

## Open questions

- Package names: `pi-model-families` / `pi-herdr-agents` or scoped npm names?
- Should model-family extension expose an event/API for other extensions, or should Herdr read JSON directly?
- Should Herdr package support non-Pi child agents later, or stay Pi-only initially?
- Should dotfiles track Herdr’s Pi integration file or treat it as generated state?
- What is the exact Herdr CLI command set for current Homebrew `herdr` version? Verify before coding.
