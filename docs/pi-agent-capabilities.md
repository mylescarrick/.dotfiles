# Pi Coding Agent — Capabilities Reference

Research notes on how the `pi` coding agent (`@earendil-works/pi-coding-agent`, v0.80.6) supports
orchestration, looping, extensions, prompt templates/skills, project-level overrides, and model
defaults. All findings are from **primary local sources only**: the installed package, its bundled
docs, and local config.

Sources:
- Installed package: `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/`
  (docs under `docs/`, `README.md`; binary symlinked from `~/.bun/bin/pi`).
- User config: `~/.pi/agent/` (`settings.json`, `claude-bridge.json`, `extensions/`, `skills/`, `trust.json`).
- Knoxi project config: `~/projects/knoxi-apps/.pi/` and `~/projects/knoxi-apps/.agents/`.

Researched 2026-07-11.

---

## TL;DR

Pi is a deliberately **minimalist, extension-driven** agent. It ships **no built-in orchestration,
no sub-agents, no plan mode, no looping/cron, and no dynamic model routing**. Everything beyond the
core loop is expected to be added via its **extension API** (TypeScript, loaded with `jiti`), its
**skills** system (Agent Skills standard), and **prompt templates**. Config is layered global →
project, gated by a **trust** decision. Model defaults are **static** (settings + `/model` +
`--model`); anything adaptive is an extension concern.

---

## 1. Orchestration / sub-agents

**Not built in — intentional.**

- `README.md:17` — "Pi ships with powerful defaults but skips features like sub agents and plan mode."
- `README.md:379` — lists "Sub-agents and plan mode" under omitted features.
- `README.md:493` — "**No sub-agents.** There's many ways to do this. Spawn pi instances via tmux,
  or build your own with extensions, or install a package that does it your way."
- `README.md:501` — "**No background bash.** Use tmux."

Ways to achieve orchestration instead:
- **tmux**: run multiple independent `pi` sessions (`docs/tmux.md`).
- **RPC / headless**: `pi --mode rpc` drives the agent over JSON stdin/stdout for subprocess control (`docs/rpc.md`).
- **SDK**: embed via `createAgentSession()` / `AgentSessionRuntime` from the package (`docs/sdk.md`, `README.md:455`).
- **Extension session handoff**: extensions can fork/replace sessions and inject kickoff prompts —
  `withSession` gives a `ReplacedSessionContext` with `sendMessage()`/`sendUserMessage()`
  (`docs/extensions.md` ~lines 1186–1258). This is the closest native primitive to delegation.

Knox's own harness note confirms this: `~/projects/knoxi-apps/.agents/skills/references/harness-modes.md:14`
— "No built-in subagents. … Prefer inline sequential execution and targeted file reads."

## 2. Looping / cron / watch

**Not built in.** There is no loop, repeat, cron, interval, or watch primitive in pi's core or docs.

To loop, use one of:
- External scheduler (bash `while`, cron, systemd timer) invoking `pi -p` (print mode).
- An **extension** that registers a timer/background resource. Extensions must defer background
  resources to `session_start` (not the factory) and clean up in an idempotent `session_shutdown`
  handler (`docs/extensions.md`, "Long-lived resources and shutdown").

(Note: the Claude Code harness this file was written under has its own `/loop` skill and cron tools —
those are **not** pi features.)

## 3. Extensions

Pi's primary extensibility mechanism. TypeScript modules loaded via `jiti` (no build step).

**Discovery locations** (`docs/extensions.md`):
- Global: `~/.pi/agent/extensions/*.ts` or `~/.pi/agent/extensions/*/index.ts`.
- Project-local (**only after trust**): `.pi/extensions/*.ts` or `.pi/extensions/*/index.ts`.
- Extra paths via `settings.json` `"extensions": [...]`, or CLI `-e <path>`.
- Packages can ship extensions via a `pi.extensions` array in their `package.json`.

**Shape** — default-export a factory (sync or async) receiving `ExtensionAPI`:
```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("event", async (event, ctx) => { /* ... */ });
  pi.registerTool({ /* ... */ });
  pi.registerCommand("name", { /* ... */ });
  pi.registerShortcut("ctrl+x", { /* ... */ });
  pi.registerFlag("my-flag", { /* ... */ });
}
```

**Available imports inside an extension**: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
`@earendil-works/pi-tui`, `typebox`, `node:*`, and any npm dep declared in the extension's own `package.json`.

**Key APIs** (`docs/extensions.md`): `pi.registerCommand`, `pi.registerTool`, `pi.appendEntry`
(durable session state), `pi.registerEntryRenderer`, `pi.sendUserMessage(content, { deliverAs })`,
`pi.setModel(model)`, `pi.setThinkingLevel(level)`, plus `ctx.modelRegistry` / `ctx.model`,
`ctx.ui.notify` / `ctx.ui.setStatus`, `ctx.sessionManager`, `ctx.cwd`, `ctx.isIdle()`.

**Events** (subscribe via `pi.on`): lifecycle (`project_trust`, `session_start`,
`resources_discover`, `session_before_*`/`session_shutdown`), agent turn (`input`,
`before_agent_start`, `agent_start`, `turn_start/end`, `agent_end`, `agent_settled`), tools
(`tool_call` (blockable), `tool_execution_*`, `tool_result`), model (`model_select`,
`thinking_level_select`), provider (`before_provider_request`, `after_provider_response`), and
`context` (mutate messages before the LLM call).

The user's global `~/.pi/agent/extensions/` already holds several (answer, git-interceptor,
pi-cloak, pi-skill-toggle, a local supacode extension). The dir is a bun workspace
(`~/.pi/package.json` `"workspaces": ["agent/extensions/*"]`).

## 4. Prompt templates & skills

Two distinct mechanisms.

### Prompt templates (`docs/prompt-templates.md`)
- Markdown + YAML frontmatter (`description`, `argument-hint`).
- Loaded from `~/.pi/agent/prompts/*.md` (global), `.pi/prompts/*.md` (project, post-trust),
  package `prompts/` dirs, `settings.json` `prompts` array, or `--prompt-template <path>`.
- Invoked as `/name` in the editor; args via `$1`, `$2`, `$@`, `${1:-default}`, `${@:N}`, `${@:N:L}`.

### Skills (`docs/skills.md`) — implements the Agent Skills standard
- Loaded from `~/.pi/agent/skills/` and `~/.agents/skills/` (global); `.pi/skills/` and
  `.agents/skills/` (project, post-trust); package `skills/` dirs or `pi.skills` in package.json;
  `settings.json` `skills` array; or `--skill <path>`.
- Discovery: in `~/.pi/agent/skills/` and `.pi/skills/`, root `.md` files are individual skills; in
  all locations, directories containing `SKILL.md` are found recursively; in `~/.agents/skills/`
  root `.md` files are ignored.
- `SKILL.md` frontmatter: `name` (required, 1–64 chars, `[a-z0-9-]`), `description` (required, ≤1024
  chars), optional `license`, `compatibility`, `allowed-tools`, `disable-model-invocation`.
- Flow: at startup pi extracts name+description into the system prompt; the agent reads the full
  `SKILL.md` when a task matches. Invoke explicitly with `/skill:<name> [args]`.
- `settings.json` `"enableSkillCommands": true` enables the `/skill:*` commands.
- Skills can be pinned/installed via a `skills-lock.json` (see knoxi-apps for github/local sources).

## 5. Project-level overrides

Config is layered **global → project**, with project layers loaded **only after the project is trusted**.

**Global**: `~/.pi/agent/{settings.json, SYSTEM.md, APPEND_SYSTEM.md, AGENTS.md}` plus
`extensions/`, `skills/`, `prompts/`, `themes/`.
**Project** (post-trust): `.pi/{settings.json, SYSTEM.md, APPEND_SYSTEM.md}` plus `.pi/extensions/`,
`.pi/skills/`, `.pi/prompts/`, `.pi/themes/`. Also `AGENTS.md`/`CLAUDE.md` walked up from cwd to git
root, and `.agents/skills/` in cwd + ancestors.

**Merge semantics** (`docs/settings.md`): project `settings.json` **deep-merges** into global —
nested objects merge key-by-key (e.g. project `compaction.reserveTokens` overrides just that field,
keeping global `compaction.enabled`).

**Trust** (`docs/settings.md`, `README.md:289`):
- Decision stored **globally** in `~/.pi/agent/trust.json` (path → bool), never project-local.
- Before trust: context files + user/global extensions + CLI `-e` extensions load. After trust:
  project extensions, project package extensions, `.pi/settings.json`, and `.pi` resources load.
- Interactive mode prompts; `/trust` records it. Non-interactive (`-p`, `--mode json`, `--mode rpc`)
  uses `defaultProjectTrust` (`"ask"` default | `"always"` | `"never"`), overridable with
  `--approve` / `--no-approve`.

## 6. Model defaults

**Static configuration**, three layers:

**Global `settings.json`** (`~/.pi/agent/settings.json`, tracked in this repo after these changes):
```json
{
  "theme": "dark",
  "defaultProvider": "github-copilot",
  "defaultModel": "gpt-5.4-mini",
  "defaultThinkingLevel": "low",
  "packages": ["npm:pi-claude-bridge", "npm:pine-of-glass"]
}
```
Related keys (`docs/settings.md`): `hideThinkingBlock`, `thinkingBudgets` (per-level token budgets),
`enabledModels` (glob list for Ctrl+P/Shift+Ctrl+P cycling). Thinking levels: `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`.

**Custom models/providers** (`~/.pi/agent/models.json`, `docs/models.md`): define providers
(`baseUrl`, `api` ∈ `openai-completions`|`openai-responses`|`anthropic-messages`|`google-generative-ai`,
`apiKey`) and per-model overrides (`contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`,
`cost`, `input`). ~30 providers ship built-in (`README.md:98`).

**CLI overrides** (`README.md:547`): `--provider`, `--model <pattern>` (supports `provider/id` and
`:thinking` suffix, e.g. `sonnet:high`), `--models <patterns>`, `--thinking <level>`,
`--api-key`, `--list-models`. Runtime: the `/model` command.

**Anthropic bridge** (`~/.pi/agent/claude-bridge.json`): `askClaude` + `provider.plan` settings for
the `pi-claude-bridge` package.

**Env vars** (`README.md:656`): `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`,
`PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CACHE_RETENTION`.

**There is no built-in dynamic/per-turn model routing.** The default model is fixed until changed by
`/model`, a flag, or an extension calling `pi.setModel()`.

This repo now implements dynamic role-based defaults as a global extension at
`home/.pi/agent/extensions/model-families/`, with global family definitions in
`home/.pi/agent/model-families.json` and trusted project overrides via `.pi/model-families.json`.

---

## Knoxi-apps: model-default management, and pi's built-in alternative

`~/projects/knoxi-apps/.pi/extensions/` contains project-local extensions (`confluence-kb`,
`dependency-review`, `linear`, `playwright-browser`, and **`knox-model-router`**). The relevant one
for model defaults is **`knox-model-router`** (`.pi/extensions/knox-model-router/index.ts`).

**What it does** — a coarse, automatic model router that switches provider+model+thinking at
**agent-turn boundaries** (to preserve provider/prompt-cache locality during tool loops):

- **Tiers** (`DEFAULT_TARGETS`): `fast` (`github-copilot/gpt-5.4-mini`, low), `premium`
  (`github-copilot/claude-sonnet-4.6`, high), `ultra` (`github-copilot/gpt-5.5`, high), plus
  Cloudflare Workers AI trials `cf-fast` (Kimi K2.7 Code) and `cf-coding` (GLM 5.2).
- **Auto classification** (`classify()`): regex/skill matching on the prompt + active skills picks a
  tier per turn (planning/review/authz/architecture/refactor → premium; build/fix/investigate → fast).
- **Turn lifecycle**: `before_agent_start` applies the tier; `agent_end` **returns to `fast`** after
  an elevated turn so follow-up work is cheap.
- **Manual controls** via registered commands: `/knox-model {status|auto|fast|premium|ultra|cf-fast|
  cf-coding|architect|lock|reload}`, `/escalate [tier] [prompt]`, `/escalate-ultra`, `/deescalate`.
  Skill aliases (`/knox-plan`, `/knox-build`, `/knox-pr`, `/knox-review`, `/knox-ship`, `/knox-commit`,
  `/knox-kb`, `/knox-align`, `/knox-authz`, `/knox-cloudflare`) set the route **then** forward to
  `/skill:<name>`.
- **State**: persisted across restarts via `pi.appendEntry("knox-model-router-state", ...)` and
  restored in `session_start` (routing mode, thinking override, locked model).
- **Config override**: `.pi/knox-model-router.json` (`{ "targets": { <tier>: {provider, model,
  thinkingLevel} } }`), reloaded with `/knox-model reload` — no code edit needed.
- Respects manual `/model` and Shift+Tab thinking changes (via `model_select` /
  `thinking_level_select` events + a short debounce), and can `lock` to freeze routing.

It's a real pi extension: `package.json` declares `"pi": { "extensions": ["./index.ts"] }` and a
peer dep on `@earendil-works/pi-coding-agent`. The knoxi docs describe it at
`.agents/skills/references/pi-model-routing.md` and `harness-modes.md`.

**Does pi have a built-in alternative? No.** Pi's native model handling is **static**: one default
model (`settings.json` `defaultProvider`/`defaultModel`/`defaultThinkingLevel`), manual `/model`
switching, `--model`/`--models` flags, and `enabledModels` for manual Ctrl+P cycling. There is **no
built-in tiering, per-turn classification, auto-escalate/de-escalate, or return-to-cheap-model
behavior**. `knox-model-router` is a bespoke layer built entirely on the public extension API
(`pi.setModel`, `pi.setThinkingLevel`, `ctx.modelRegistry`, `before_agent_start`/`agent_end`/
`model_select` events, `pi.registerCommand`, `pi.appendEntry`) precisely because pi ships nothing
equivalent. The nearest built-in fallback — noted in the router's own docs — is to use `/model`
manually and follow the tiering by hand.
