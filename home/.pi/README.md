# .pi

Global Pi configuration, stowed to `~/.pi` by this dotfiles repository.

## Extension dependency workspace

Package-style global extensions remain under `agent/extensions/` so Pi auto-discovers their `index.ts` entry points. This is the Bun workspace root for extensions that declare their own dependencies.

```bash
bun install       # Install or refresh local extension dependencies
bun run check     # Run checks for tested local extensions
```

Global extensions must be useful across repositories. Put project- or stack-specific behavior in that project's `.pi/` resources instead.

Runtime Pi package sources are tracked in `../../config/pi/settings.defaults.json` and synced into private `~/.pi/agent/settings.json` by `dot apply` / `dot update`.

After changing extension code or package settings, reload Pi with `/reload` or restart the session.
