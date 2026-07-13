# .pi

Global pi config, synced via dotfiles and stowed into `~/.pi`.

## Extension dependency workspace

Package-style global extensions stay in `agent/extensions/` so pi can still auto-discover them from:

- `~/.pi/agent/extensions/*.ts`
- `~/.pi/agent/extensions/*/index.ts`

This directory is the shared Bun workspace root for local extensions with their own `package.json` files.

Install or refresh all local extension dependencies from here:

```bash
bun install
```

Run workspace checks:

```bash
bun run check
```

Current workspace-managed local extensions live under:

- `agent/extensions/opencode-cloudflare`
- `agent/extensions/save-md`
- `agent/extensions/web-tools`
- `packages/pi-model-families/extensions/model-families`

Global model-family defaults are tracked in `agent/model-families.json`; trusted projects can override them with `.pi/model-families.json`.

Runtime Pi package sources are tracked in `../../config/pi/settings.defaults.json` and synced into `~/.pi/agent/settings.json` with `dot pi-settings sync`. Published packages currently include `@mobrienv/pi-tidy-tools` and `@mobrienv/pi-tidy-subagents`; local package prototypes live under `packages/` and are referenced with paths relative to the runtime settings file.

Package/publish helpers for local packages:

```bash
bun run pack:pi-packages          # build tarballs in out/ for inspection
bun run publish:pi-model-families # publish one package with bun publish
bun run publish:pi-packages       # publish all local packages
```

Before publishing, authenticate with `bunx npm login` (or another npm-compatible login flow) and confirm the package names/visibility are still intended.

After changing extension code or package settings, reload pi with `/reload` or restart the session.
