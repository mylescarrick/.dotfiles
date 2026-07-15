---
name: model-families
description: Manage Pi model-family config. Use when creating, editing, auditing, disabling, or choosing role-based model families, providers, models, inputs, or thinking levels.
---

# Model Families

Use this skill before editing Pi `model-families.json` or changing role-based model routing.

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
4. Prefer exact provider/model ids from `/mf models`; do not guess or normalize ids by hand.
5. Use `disabled: true` for families that should remain documented/auditable but not selectable.

## Roles

Use the five standard roles:

- `research`: docs, API/library investigation, current/web lookup, external comparisons
- `architecture`: system design, module boundaries, interface design, ADR/domain/data/state modeling
- `planning`: PRDs, implementation plans, sequencing, proposals, approach/strategy decisions
- `delivery`: normal coding, fixes, debugging, implementation, wiring features together
- `verification`: tests, lint, typecheck, validation, CI failures, review/acceptance evidence

`architecture` decides shape; `planning` decides sequence. `delivery` changes code; `verification` proves the change.

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
