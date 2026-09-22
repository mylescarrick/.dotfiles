# Pi Provider Extensions for Claude and Cursor Subscriptions

Research question: *What are the best Pi provider extensions for using Claude and Cursor subscriptions (not API keys) directly in Pi?*

## Bottom line

For subscription-only access in the Pi coding-agent harness (`@earendil-works/pi-coding-agent`), the current best options are:

- **Claude:** `npm:pi-claude-bridge` (already present in this repo's defaults) or the newer `npm:pi-claude-code-provider` if you prefer a documented public protocol over the Agent SDK.
- **Cursor:** `npm:@rahularya01/pi-cursor` offers the most mature native Pi integration, though it is an unofficial reverse-engineered client. If you want tostay on Cursor's officially supported surface, use `npm:@akepka/pi-cursor-cli-provider` or `npm:@netandreus/pi-cursor-provider`, both of which shell out to the Cursor Agent CLI.

Avoid `npm:pi-cursor-sdk` if your goal is to bill against a Cursor subscription; it requires a Cursor SDK API key.

---

## Claude subscription providers

### `npm:pi-claude-bridge`

- **Auth model:** Uses your existing Claude Code installation and Anthropic Agent SDK; no separate Anthropic API key.
- **Billing:** Draws from your Claude Pro/Max/Team/Enterprise subscription usage limits (same as Claude Code). Anthropic paused a planned Agent-SDK-only credit change on June 15, 2026, so for now it still consumes subscription quota.[^anthropic-agent-sdk-billing][^pi-claude-bridge]
- **Status in this repo:** Already listed in `config/pi/settings.defaults.json`.
- **Maturity:** v0.8.0, ~40.8K npm downloads/month, active maintenance, extensive test suite, `askClaude` delegation tool, skills forwarding, session resume/persistence.
- **Caveats:** Known to rewrite Claude Code sessions from Pi history on abort/compact/tree navigation, which can lose prompt cache and some file-edit snapshots. `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` env vars leak into the child process and can break auth.[^pi-claude-bridge-readme]

### `npm:pi-claude-code-provider`

- **Auth model:** Spawns the installed `claude` executable in Anthropic's documented non-interactive `claude --print` mode; uses your Claude Code subscription login.[^pi-claude-code-provider]
- **Billing:** Consumes the Claude subscription capacity (Pro, Max, Team, Enterprise). It deliberately does not use API keys, Bedrock, Vertex, or Foundry.[^pi-claude-code-provider]
- **Approach:** Advertised as "never imitates private OAuth traffic, does not use the Agents SDK, and does not modify Claude's internal session files."
- **Maturity:** v0.4.0, ~1.6K downloads/month. Requires Pi 0.86.1+, Claude Code 2.1.270+, Node 22.19+.
- **Trade-off:** Sends full Pi history on every request because Claude Code's public headless protocol cannot accept arbitrary past messages; uses more context than the Messages API.[^pi-claude-code-provider]

### Also noted

- `npm:pi-claude-agent-sdk`, `@fractaal/pi-claude-bridge`, and `@vanillagreen/pi-claude-bridge` are forks/alternatives of the same Agent SDK approach. `pi-claude-bridge` remains the most downloaded and actively maintained.

---

## Cursor subscription providers

### `npm:@rahularya01/pi-cursor` — recommended native option

- **Auth model:** Reuses existing Cursor desktop app or Cursor CLI login, or browser PKCE OAuth via `/login cursor`. Falls back to `CURSOR_ACCESS_TOKEN`.[^pi-cursor-rahularya]
- **Billing:** Uses the Cursor subscription; no separate API key for the models themselves.
- **Approach:** Unofficial integration that speaks Cursor's native Connect/protobuf streaming over HTTP/2 directly (reverse-engineered). It explicitly notes it is not affiliated with Cursor/Anysphere.[^pi-cursor-rahularya]
- **Maturity:** v1.4.36, ~3.9K downloads/month, very detailed README, built-in `/cursor.doctor`, `/cursor.models`, and `/cursor.usage` dashboard, cross-platform (macOS, Linux, Windows, WSL).
- **Caveat:** Because it relies on reverse-engineered wire protocol details, a Cursor backend change can break the provider until the package is updated.[^pi-cursor-rahularya]

### `npm:pi-cursor-agent` — alternative reverse-engineered option

- **Auth model:** Uses `/login` and browser-based Cursor OAuth.[^pi-cursor-agent]
- **Billing:** Uses your Cursor subscription.[^pi-cursor-agent]
- **Approach:** Reverse-engineered Cursor Agent provider; described by `@akepka/pi-cursor-cli-provider` as "the most complete implementation that uses the reverse-engineered API."[^akepka-readme]
- **Maturity:** v0.4.4, ~668 downloads/month, broad model support including Claude, GPT, Gemini, Grok, Composer, Kimi.

### CLI-based options (official Cursor Agent CLI surface)

If you would rather not rely on a reverse-engineered client, the following providers shell out to the [Cursor Agent CLI](https://cursor.com/docs/cli/overview) (`agent`), which is Cursor's own supported command-line tool.

- **`npm:@akepka/pi-cursor-cli-provider`** — v0.10.1, ~964 downloads/month. Fork of `@netandreus/pi-cursor-provider`. Routes each Pi turn through `agent --print --output-format stream-json ...`. Supports Cursor subscription login or `CURSOR_API_KEY` as a fallback.[^akepka-pi-dev]
- **`npm:@netandreus/pi-cursor-provider`** — v0.1.4, ~248 downloads/month. Earlier implementation of the same CLI-spawn approach. The Cursor CLI handles authentication; the provider passes the prompt and maps NDJSON output back to Pi.[^netandreus-pi-dev]

Trade-offs of the CLI approach:

- Pros: Uses Cursor's official CLI; no protocol spoofing.
- Cons: Spawns a subprocess per turn (or per first turn + resumed sessions for `@akepka`), no image input support in `--print` mode (per `@netandreus`), token usage is estimated or zero, fewer Pi-native affordances than `@rahularya01/pi-cursor`.

### `npm:pi-cursor-provider` (local proxy)

- **Auth model:** PKCE OAuth (`/login cursor`).[^pi-cursor-provider]
- **Billing:** Cursor subscription.
- **Approach:** Spins up a local OpenAI-compatible HTTP proxy that translates `/v1/chat/completions` to Cursor's protobuf/HTTP2 Connect protocol. v0.1.11, low visibility in npm stats.

---

## Options that require an API key (avoid for subscription-only use)

- **`npm:pi-cursor-sdk`** — Built on the official `@cursor/sdk` and requires a **Cursor SDK API key** from the Cursor Dashboard or team settings. It is emphatically not subscription-billed.[^pi-cursor-sdk]

---

## Recommendation for `config/pi/settings.defaults.json`

This repo already declares `npm:pi-claude-bridge`. The minimal change for subscription-based Cursor access is to add the most mature subscription provider:

```json
{
  "packages": [
    "npm:pi-claude-bridge",
    "npm:pi-mcp-adapter",
    "npm:pine-of-glass",
    "npm:@mobrienv/pi-tidy-tools",
    "npm:@mobrienv/pi-tidy-subagents",
    "npm:@rahularya01/pi-cursor"
  ]
}
```

If you prefer to avoid reverse-engineered Cursor clients, replace `npm:@rahularya01/pi-cursor` with either `npm:@akepka/pi-cursor-cli-provider` or `npm:@netandreus/pi-cursor-provider`, but note that you must also install the Cursor Agent CLI (`agent`) separately and authenticate it with your Cursor subscription.

For Claude, if you want the most conservative/public-protocol route, swap `npm:pi-claude-bridge` for `npm:pi-claude-code-provider`.

---

## Sources

[^pi-claude-bridge]: Pi package registry — `pi-claude-bridge`, https://pi.dev/packages/pi-claude-bridge
[^pi-claude-bridge-readme]: `pi-claude-bridge` README on GitHub, https://github.com/elidickinson/pi-claude-bridge/blob/main/README.md
[^pi-claude-code-provider]: Pi package registry — `pi-claude-code-provider`, https://pi.dev/packages/pi-claude-code-provider
[^anthropic-agent-sdk-billing]: Anthropic Help Center — "Use the Claude Agent SDK with your Claude plan", https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
[^pi-cursor-rahularya]: Pi package registry — `@rahularya01/pi-cursor`, https://pi.dev/packages/@rahularya01/pi-cursor
[^pi-cursor-agent]: Pi package registry — `pi-cursor-agent`, https://pi.dev/packages/pi-cursor-agent
[^akepka-pi-dev]: Pi package registry — `@akepka/pi-cursor-cli-provider`, https://pi.dev/packages/@akepka/pi-cursor-cli-provider
[^akepka-readme]: `@akepka/pi-cursor-cli-provider` README on GitHub, https://github.com/Strus/pi-cursor-cli-provider/blob/main/README.md
[^netandreus-pi-dev]: Pi package registry — `@netandreus/pi-cursor-provider`, https://pi.dev/packages/@netandreus/pi-cursor-provider
[^pi-cursor-provider]: Pi package registry — `pi-cursor-provider`, https://pi.dev/packages/pi-cursor-provider
[^pi-cursor-sdk]: Pi package registry — `pi-cursor-sdk`, https://pi.dev/packages/pi-cursor-sdk
