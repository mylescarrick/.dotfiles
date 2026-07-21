---
name: model-families-dev
description: Maintain this dotfiles repo's Pi model-family config and extension. Use when editing tracked model-family families, docs, audit tooling, providers, models, inputs, or thinking levels.
---

# Model Families Dev

Use this project-local skill before editing this dotfiles repo's tracked Pi `model-families.json`, model-family extension, or role-based routing docs.

## Files

- Global config: `~/.pi/agent/model-families.json` in the live environment; tracked copy is `home/.pi/agent/model-families.json` in dotfiles.
- Trusted project override: `.pi/model-families.json`.
- Extension docs: `home/.pi/packages/pi-model-families/extensions/model-families/README.md`.

## Workflow

1. Inspect the current family state:
   ```text
   /mf status
   /mf list
   /mf audit
   ```
2. Inspect exact provider/model ids before writing config:
   ```text
   /mf models <provider-or-model-query>
   ```
3. For every configured role, confirm:
   - provider/model exists in Pi's model registry
   - auth is configured for the provider in this runtime
   - required env placeholders are set when a provider URL needs them
   - `thinkingLevel` is supported by that model
   - model `input` supports the task (`text` vs `text,image`)
4. For every `manualTargets` entry, confirm the same registry/auth/thinking/input facts as roles.
5. Prefer exact provider/model ids from `/mf models`; do not guess or normalize ids by hand.
6. Use `disabled: true` for families that should remain documented/auditable but not selectable.
7. Run the extension check when touching the extension or policy: `bun run --cwd home/.pi/packages/pi-model-families/extensions/model-families check`.

## Roles

Use the five standard roles:

- `research`: docs, API/library investigation, current/web lookup, external comparisons
- `architecture`: system design, module boundaries, interface design, ADR/domain/data/state modeling
- `planning`: PRDs, implementation plans, sequencing, proposals, approach/strategy decisions
- `delivery`: normal coding, fixes, debugging, implementation, wiring features together
- `verification`: tests, lint, typecheck, validation, CI failures, review/acceptance evidence

`architecture` decides shape; `planning` decides sequence. `delivery` changes code; `verification` proves the change.

## Cost and cache stability

Automatic routing optimizes for cache locality: keep every role in a family on the **same** model and thinking level so ordinary prompts never switch models (the `azure-gpt` family uses Terra/medium for all five roles). The extension applies a model/thinking change only when it actually differs, and there is no per-turn escalate/return. Only give a role a distinct model when that role genuinely needs one.

## Manual targets

Expensive or cheap models that should be used only on purpose belong in a family's `manualTargets` map, never in automatic roles:

```json
"manualTargets": {
  "sol": { "description": "...", "provider": "azure-openai-responses", "model": "gpt-5.6-sol", "thinkingLevel": "high" }
}
```

`/mf target <name>` (alias `/mf escalate <name>`) applies and locks the target for the session; `/mf auto` returns to automatic routing. Manual targets are audited alongside roles but are never chosen by prompt classification.

## Thinking levels

Allowed Pi thinking levels:

```text
off, minimal, low, medium, high, xhigh, max
```

Rules:

- Non-reasoning model supports only `off`.
- Reasoning model with no explicit `thinkingLevelMap` supports `off`, `minimal`, `low`, `medium`, `high`.
- `xhigh` and `max` require explicit model metadata support.
- A level mapped to `null` is unavailable.
- If a role omits `thinkingLevel`, the extension leaves the current level unchanged; define it on every role for predictable routing.

## Cloudflare gotcha

Cloudflare direct Workers AI and AI Gateway use different provider/model ids:

```text
cloudflare-workers-ai/@cf/zai-org/glm-5.2
cloudflare-ai-gateway/workers-ai/@cf/zai-org/glm-5.2
```

When moving a family between the two, update both `provider` and `model`. Check `/mf audit` for suggested equivalents and missing `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_GATEWAY_ID` placeholders.

## Completion criterion

Before finishing, report:

- changed family names
- disabled/enabled family changes
- audit result or why it could not be run
- verification command results
