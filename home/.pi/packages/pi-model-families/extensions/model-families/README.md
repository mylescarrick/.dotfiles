# model-families

Global Pi extension for role-based model defaults.

Pi's built-in model defaults are static (`defaultProvider`, `defaultModel`, and `defaultThinkingLevel`).
This extension adds a small routing layer on top: pick a **family**, then let each prompt route to a
role-specific model inside that family.

Routing favours cache locality and predictable cost. Automatic role targets in a family are meant to
share one model and thinking level so ordinary turns do not switch models. Model/thinking transitions
are applied only when they actually change; a route to the model already in effect is a no-op. Premium
or budget models that should be used only deliberately belong in `manualTargets`, not in automatic
roles.

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

| Role | Use for |
|------|---------|
| `research` | Docs, API/library investigation, web/current-info lookup, comparing external options |
| `architecture` | System design, module boundaries, interface design, ADRs, domain/data/state modeling, deep refactors |
| `planning` | PRDs, implementation plans, sequencing, proposals, approach/strategy decisions |
| `delivery` | Normal coding, fixes, debugging, implementation, wiring features together |
| `verification` | Tests, lint, typecheck, validation, CI failures, review evidence, acceptance checks |

For cost stability, keep every automatic role on the same model and thinking level (the shipped
`azure-gpt` family uses Terra/medium for all five). Reserve stronger or cheaper models for
`manualTargets`.

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

## Manual targets

A family may define `manualTargets`: named models that are never chosen automatically and must be
selected explicitly. Use them for exceptional escalation (a stronger model) or deliberate budget work
(a cheaper model).

```json
{
  "families": {
    "azure-gpt": {
      "roles": { "delivery": { "provider": "azure-openai-responses", "model": "gpt-5.6-terra", "thinkingLevel": "medium" } },
      "manualTargets": {
        "sol": {
          "description": "Exceptional long-horizon reasoning",
          "provider": "azure-openai-responses",
          "model": "gpt-5.6-sol",
          "thinkingLevel": "high"
        }
      }
    }
  }
}
```

Select one with `/mf target <name>` (or the `escalate` alias). This applies the target and **locks**
routing to it for the rest of the session; run `/mf auto` to return to automatic role routing. Manual
targets are validated by `/mf audit` alongside roles.

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
/model-family target <name> [prompt] # apply and lock an explicit manual target; optionally send prompt
/model-family escalate <name> [prompt] # alias for target
/model-family models [query]  # inspect registered model ids, inputs, auth, and thinking support
/model-family audit [family]  # validate configured families against the current Pi model registry
/model-family lock            # stop routing and keep the current manually selected model
/model-family reload          # reload global + project JSON
```

`/mf` is an alias for `/model-family`.

Manual `/model` or Ctrl+P model changes lock routing. Use `/model-family auto` or
`/model-family use <family>` to resume.

## Routing behavior

When in auto mode, the extension classifies each user prompt just before the agent starts. Only the
submitted prompt text is inspected — loaded skill names do not influence classification. Signals are
checked in this order, so earlier matches win:

1. docs, web/current-info, API/library questions → `research`
2. design, architecture, planning, ADR/domain modeling, deep refactors → `architecture`/`planning`
3. normal implementation/fix/debug/delivery → `delivery`
4. verification/test/lint/typecheck/review evidence → `verification`

When automatic role targets share one model and thinking level (the recommended setup), classification
never causes a model switch, so there is no post-turn reset. A switch only happens when a family
defines genuinely different targets per role.

## Tidy subagents

When the process is a tidy child (`PI_TIDY_SUBAGENT_CHILD=1`), the extension locks routing at startup,
skips restoring parent session state, and does not set a model — so the child's explicitly selected
`--model`/`--thinking` remain authoritative. Routing commands (`/mf ...`) are disabled in child
processes.
