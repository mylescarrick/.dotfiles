# PI AGENT WORKSPACE

Global Pi configuration and local extensions, stowed to `~/.pi`.

## Structure

```text
.pi/
├── agent/
│   ├── settings.json          # Private runtime settings, synced from config/pi defaults
│   ├── extensions/            # Global, universal extensions only
│   ├── skills/                # Symlinks to canonical ~/.agents/skills
│   └── themes/
├── package.json               # Bun workspace root
└── tsconfig.json
```

## Commands

```bash
bun install                    # Install workspace dependencies
bun run check                  # Check tested local extensions
```

## Conventions

- Use Bun commands in this workspace.
- For repository content searches, prefer `rg` over `grep` or broad shell scans; use `-F` for literal text, and remember it respects `.gitignore` and skips hidden files unless requested.
- Keep global extensions universal. Put stack- or repository-specific behavior in the relevant project's `.pi/` directory or `.agents/skills`.
- Select models and thinking deliberately with Pi's built-in controls; do not add automatic model routing.
- Published Pi packages are declared in `config/pi/settings.defaults.json` and synced into private runtime `~/.pi/agent/settings.json` by `dot apply` / `dot update`.
- Delegation in Pi uses `@mobrienv/pi-tidy-subagents` when justified. Keep children read-only unless writes are explicitly approved, and use separate worktrees for parallel writes.

## Package ownership

| Package | Purpose |
|---|---|
| `@mobrienv/pi-tidy-tools` | Compact rendering for built-in Pi tool calls and `/diff` recap. |
| `@mobrienv/pi-tidy-subagents` | Foreground/background child Pi agents for justified delegation. |

## Using Cloudflare?

- When interacting with Cloudflare, use the `cf` CLI unless the project has a Wrangler configuration file (e.g. `wrangler.jsonc`).
- If the app has a Wrangler config file, suggest updating it with `cf migrate --dry-run` → `cf migrate`.
- Find the appropriate command options with `cf cli search`, for example: `cf cli search "create D1 database"`.
- If necessary, prompt the user to sign in interactively with `cf auth login`.

## Anti-patterns

- Editing live `~/.pi/agent/settings.json` instead of dotfiles defaults/runtime sync.
- Adding node_modules or generated artifacts to git.
- Encoding private/local overlay model IDs in tracked files.
- Making Claude Code depend on Pi-specific subagent behavior.
