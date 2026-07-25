# web-tools

Pi extension that registers two public-web tools:

- `webfetch` — fetch one public URL as markdown, text, html, or an inline raster image
- `websearch` — search the public web for current information and candidate URLs

## Tools

### `webfetch`

Parameters:

- `url` — required
- `format` — optional: `markdown`, `text`, `html`
- `timeout` — optional timeout in seconds, clamped to `1..120`

Current defaults:

- `defaultFormat`: `markdown`
- `timeoutSeconds`: `30`
- `maxResponseBytes`: `5 MB`
- `blockPrivateHosts`: `true`
- `maxRedirects`: `5`
- `fallbackUserAgent`: `opencode`

Behavior notes:

- only `http://` and `https://` URLs are supported
- URL userinfo credentials (`https://user:pass@example.com`) are rejected and redacted in diagnostics
- private/local hosts and IPs are blocked by default
- raster images (`png`, `jpeg`, `gif`, `webp`) are returned inline as images
- HTML is converted to markdown or text when requested
- binary content is rejected
- if a site returns `403` with `cf-mitigated: challenge`, the tool retries with the fallback user agent

### `websearch`

Parameters:

- `query` — required
- `maxResults` — optional, clamped to `1..20`
- `depth` — optional: `auto`, `fast`, `deep` (`deep` is accepted as a compatibility alias and mapped to `fast`)

Current defaults:

- `enabled`: `true` only when an Exa API key is configured via `dot pi auth exa`; otherwise `false`
- `provider`: `exa`
- `endpoint`: `https://mcp.exa.ai/mcp`, configured in `settings.ts`
- `timeoutSeconds`: `25`
- `defaultMaxResults`: `8`
- `defaultDepth`: `auto`

Behavior notes:

- uses the configured Exa MCP-compatible endpoint
- Exa currently supports provider depths `auto` and `fast`; tool input `deep` is downgraded to `fast`
- search responses are limited to `1 MB`
- provider requests currently send:
  - `livecrawl: "fallback"`
  - `contextMaxCharacters: 2000`

#### Exa authentication

Without a key, requests go to Exa's free public MCP endpoint — rate-limited
and not suitable for real use. Configure a key with:

```bash
dot pi auth exa --api-key-op-ref 'op://vault/Exa Agentic Search/API_KEY'
# or: dot pi auth exa --api-key-env EXA_API_KEY
```

This writes a resolver reference (never the raw secret) to the private,
mode-`0600` `~/.pi/agent/web-tools-auth.json` — a file owned by this
extension, separate from Pi's own `~/.pi/agent/auth.json` (which is pi-ai's
LLM provider credential store; Exa isn't a Pi model provider). `exa-auth.ts`
reads that file, resolves the reference lazily on first search (running the
`!command` or reading the `$ENV_NAME`), caches the resolved key for the
process lifetime, and `providers/exa.ts` sends it as the `x-api-key` header.

## Configuration

The extension has an internal settings shape:

```ts
{
  fetch: {
    defaultFormat: "markdown" | "text" | "html";
    timeoutSeconds: number;
    maxResponseBytes: number;
    blockPrivateHosts: boolean;
    maxRedirects: number;
    fallbackUserAgent: string;
  };
  search: {
    enabled: boolean;
    provider: "exa";
    endpoint: PublicHttpUrl;
    timeoutSeconds: number;
    defaultMaxResults: number;
    defaultDepth: "auto" | "fast" | "deep";
  };
}
```

But in the current implementation, these are hardcoded defaults in `settings.ts`.

That means:

- `webfetch.format` and `webfetch.timeout` can be overridden per call
- `websearch.maxResults` and `websearch.depth` can be overridden per call
- the underlying defaults are not currently exposed through Pi settings, extension settings, or env vars, except `search.enabled`/`search.apiKeyRef`, which are derived from `dot pi auth exa` (see above)

To change the defaults, edit:

- `home/.pi/agent/extensions/web-tools/settings.ts`

## Source of truth

- extension entry: `home/.pi/agent/extensions/web-tools/index.ts`
- settings/defaults: `home/.pi/agent/extensions/web-tools/settings.ts`
- fetch Pi adapter: `home/.pi/agent/extensions/web-tools/webfetch.ts`
- fetch service: `home/.pi/agent/extensions/web-tools/fetch-page.ts`
- public web adapter: `home/.pi/agent/extensions/web-tools/network.ts`
- search Pi adapter: `home/.pi/agent/extensions/web-tools/websearch.ts`
- search service: `home/.pi/agent/extensions/web-tools/search-web.ts`
- Exa auth resolver: `home/.pi/agent/extensions/web-tools/exa-auth.ts`
- Exa provider adapter: `home/.pi/agent/extensions/web-tools/providers/exa.ts`
- Exa protocol parser: `home/.pi/agent/extensions/web-tools/providers/exa-protocol.ts`
- Exa result parser: `home/.pi/agent/extensions/web-tools/providers/exa-results.ts`
- tool output projection: `home/.pi/agent/extensions/web-tools/tool-output.ts`
