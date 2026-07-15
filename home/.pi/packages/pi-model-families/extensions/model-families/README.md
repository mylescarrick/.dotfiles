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

| Role | Use for | Typical thinking |
|------|---------|------------------|
| `research` | Docs, API/library investigation, web/current-info lookup, comparing external options | `high` |
| `architecture` | System design, module boundaries, interface design, ADRs, domain/data/state modeling, deep refactors | `high` |
| `planning` | PRDs, implementation plans, sequencing, proposals, approach/strategy decisions | `high` |
| `delivery` | Normal coding, fixes, debugging, implementation, wiring features together | `low`/`medium` |
| `verification` | Tests, lint, typecheck, validation, CI failures, review evidence, acceptance checks | `low` |

`architecture` decides shape; `planning` decides sequence. `delivery` changes code; `verification`
proves the change.

Roles fall back to nearby roles when a family omits one:

| Requested role | Fallback order |
|----------------|----------------|
| `research` | `research`, `architecture`, `planning`, `delivery` |
| `architecture` | `architecture`, `planning`, `research`, `delivery` |
| `planning` | `planning`, `architecture`, `research`, `delivery` |
| `delivery` | `delivery`, `verification`, `planning` |
| `verification` | `verification`, `delivery` |

Set `disabled: true` on a family to keep it visible for audit/listing while preventing selection:

```json
{
  "families": {
    "cloudflare-gateway": {
      "disabled": true,
      "roles": { "delivery": { "provider": "cloudflare-ai-gateway", "model": "workers-ai/@cf/moonshotai/kimi-k2.6" } }
    }
  }
}
```

A project override can re-enable a global family with `"disabled": false`.

## Thinking levels

Role targets may set `thinkingLevel`:

```json
{
  "provider": "azure-openai-responses",
  "model": "gpt-5.6-terra",
  "thinkingLevel": "medium"
}
```

Allowed values are:

```text
off, minimal, low, medium, high, xhigh, max
```

These are Pi-level thinking controls, not provider-specific request strings. Pi maps them through the
model's metadata and clamps unsupported levels. The supported set is derived from each model:

- non-reasoning model → `off` only
- reasoning model without `thinkingLevelMap` → `off`, `minimal`, `low`, `medium`, `high`
- `xhigh` and `max` are available only when explicitly present in `thinkingLevelMap`
- any level mapped to `null` is unavailable

If `thinkingLevel` is omitted, the extension leaves the current thinking level unchanged. For
predictable routing, define `thinkingLevel` for every role.

## Commands

```text
/model-family                 # status
/model-family list            # list configured families, including disabled ones
/model-family use <family>    # set active enabled family and resume auto-routing
/model-family auto [family]   # resume auto-routing, optionally switching family first
/model-family default         # switch to config.defaultFamily
/model-family <family>        # shorthand for use <family>
/model-family role <role> [prompt] # queue/apply a role for the next turn; optionally send prompt
/model-family <role> [prompt] # shorthand; optionally send prompt immediately
/model-family models [query]  # inspect registered model ids, inputs, auth, and thinking support
/model-family audit [family]  # validate configured families against the current Pi model registry
/model-family lock            # stop routing and keep the current manually selected model
/model-family reload          # reload global + project JSON
```

`/mf` is an alias for `/model-family`.

Manual `/model` or Ctrl+P model changes lock routing. Use `/model-family auto` or
`/model-family use <family>` to resume.

## Routing behavior

When in auto mode, the extension classifies each user prompt just before the agent starts. Signals
are checked in this order, so earlier matches win:

1. docs, web/current-info, API/library questions → `research`
2. design, architecture, planning, ADR/domain modeling, deep refactors → `architecture`/`planning`
3. verification/test/lint/typecheck/review evidence → `verification`
4. normal implementation/fix/debug/delivery → `delivery`

After an elevated role (`research`, `architecture`, or `planning`) finishes, the extension returns the
session to the configured `returnRole` (default: `delivery`) so the footer/default model stays cheap.
