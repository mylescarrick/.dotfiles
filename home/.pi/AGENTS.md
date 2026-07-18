# PI AGENT WORKSPACE

Global Pi config and local Pi package workspace, stowed to `~/.pi`.

## Structure

```text
.pi/
├── agent/
│   ├── settings.json          # Runtime-owned Provider/model/theme/packages, synced from config/pi defaults
│   ├── model-families.json    # Role-based model defaults
│   ├── cloak.json             # Secret masking patterns
│   ├── extensions/            # Global top-level extensions
│   ├── skills/                # Symlinks to canonical ~/.agents/skills
│   └── themes/
├── packages/
│   └── pi-model-families/     # Reusable local Pi package: model roles/families
├── package.json               # Bun workspace root
└── tsconfig.json
```

## Commands

```bash
bun install                    # install workspace deps
bun run check                  # all local extension checks/tests
bun run pack:pi-packages       # build local package tarballs in out/
bun run publish:pi-packages    # publish reusable local Pi packages with bun publish
```

## Conventions

- Use Bun commands in this workspace.
- Keep reusable Pi-only behavior in `packages/`, not shared `~/.agents/skills`.
- Concrete model IDs belong in `agent/model-families.json` or project `.pi/model-families.json`, not in shared skills.
- Published Pi packages are declared in `config/pi/settings.defaults.json` and synced into private runtime `~/.pi/agent/settings.json` by canonical `dot apply` / `dot update`.
- Delegation in Pi uses `@mobrienv/pi-tidy-subagents` by default; keep children read-only unless writes are explicitly approved, and use separate worktrees for parallel writes.

## Package ownership

| Package | Purpose |
|---|---|
| `pi-model-families` | Select model provider/model/thinking by role: research, architecture, planning, delivery, verification. |
| `@mobrienv/pi-tidy-tools` | Compact rendering for built-in Pi tool calls and `/diff` recap. |
| `@mobrienv/pi-tidy-subagents` | Foreground/background child Pi agents for justified delegation. |

## Anti-patterns

- Editing live `~/.pi/agent/settings.json` instead of dotfiles defaults/runtime sync.
- Adding node_modules or generated artifacts to git.
- Encoding private/local overlay model IDs in tracked files.
- Making Claude Code depend on Pi-specific subagent behavior.
