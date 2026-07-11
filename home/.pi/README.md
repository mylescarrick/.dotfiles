# .pi

Global pi config, synced via dotfiles and stowed into `~/.pi`.

## Extension dependency workspace

Package-style global extensions stay in `agent/extensions/` so pi can still auto-discover them from:

- `~/.pi/agent/extensions/*.ts`
- `~/.pi/agent/extensions/*/index.ts`

This directory is now the shared npm workspace root for extensions with their own `package.json` files.

Install or refresh all extension dependencies from here:

```bash
npm install
```

Run workspace checks:

```bash
npm run check
```

Current workspace-managed extensions live under:

- `agent/extensions/model-families`
- `agent/extensions/opencode-cloudflare`
- `agent/extensions/save-md`
- `agent/extensions/web-tools`

Global model-family defaults are tracked in `agent/model-families.json`; trusted projects can override them with `.pi/model-families.json`.

After changing extension code, reload pi with `/reload`.
