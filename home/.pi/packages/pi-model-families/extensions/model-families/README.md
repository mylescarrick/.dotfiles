# model-families

Global Pi extension for role-based model defaults.

Pi's built-in model defaults are static (`defaultProvider`, `defaultModel`, and `defaultThinkingLevel`).
This extension adds a small routing layer on top: pick a **family**, then let each prompt route to a
role-specific model inside that family.

## Config

Global defaults live in:

```text
~/.pi/agent/model-families.json
```

Trusted projects can override them with:

```text
.pi/model-families.json
```

The extension deep-merges configuration in this order:

1. built-in fallback defaults
2. global `~/.pi/agent/model-families.json`
3. project `.pi/model-families.json` (only when the project is trusted)

Example project override:

```json
{
  "defaultFamily": "claude-main",
  "families": {
    "claude-main": {
      "roles": {
        "delivery": {
          "provider": "claude-bridge",
          "model": "claude-sonnet-5",
          "thinkingLevel": "high"
        }
      }
    }
  }
}
```

A family may define these roles:

- `research`
- `architecture`
- `planning`
- `delivery`
- `verification`

Roles fall back to nearby roles when a family omits one; for example `planning` can fall back to
`architecture`, and `verification` can fall back to `delivery`.

## Commands

```text
/model-family                 # status
/model-family list            # list configured families
/model-family use <family>    # set active family and resume auto-routing
/model-family default         # switch to config.defaultFamily
/model-family <family>        # shorthand for use <family>
/model-family role <role>     # queue/apply a role for the next turn
/model-family <role> [prompt] # shorthand; optionally send prompt immediately
/model-family lock            # stop routing and keep the current manually selected model
/model-family reload          # reload global + project JSON
```

`/mf` is an alias for `/model-family`.

Manual `/model` or Ctrl+P model changes lock routing. Use `/model-family auto` or
`/model-family use <family>` to resume.

## Routing behavior

When in auto mode, the extension classifies each user prompt just before the agent starts:

- docs, web/current-info, API/library questions → `research`
- design, architecture, planning, ADR/domain modeling, deep refactors → `architecture`/`planning`
- verification/test/lint/typecheck/review evidence → `verification`
- normal implementation/fix/debug/delivery → `delivery`

After an elevated role (`research`, `architecture`, or `planning`) finishes, the extension returns the
session to the configured `returnRole` (default: `delivery`) so the footer/default model stays cheap.
