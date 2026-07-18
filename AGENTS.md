# DOTFILES

macOS dev env via GNU Stow. Zsh (oh-my-zsh) + Git + pi.

## STRUCTURE

```
.dotfiles/
├── dot                 # POSIX launcher: bootstrap/update prelude → Bun CLI
├── tools/dot/           # Bun/TypeScript application and tests
├── home/.config/       # Stowed to ~/.config/
│   ├── git/            # Conditional work config
│   ├── ghostty/        # Terminal
│   ├── starship.toml   # Prompt (2s timeout for Vite+)
│   └── ripgrep/        # rg config
├── home/.zshrc, .zprofile  # Stowed to ~
├── home/.oh-my-zsh/custom/ # Custom zsh functions/aliases (stowed into ~/.oh-my-zsh/custom/)
├── .agents/skills/     # Repo-local skills for maintaining this checkout only
├── .pi/                # Repo-local Pi resources for this checkout only
├── home/.agents/skills/    # Canonical agent-skills library (stowed to ~/.agents/skills/)
├── home/.pi/           # Pi agent workspace (AGENTS.md)
│   ├── agent/extensions/ # TypeScript extensions
│   └── agent/skills/   # symlinks into ~/.agents/skills/ for pi-specific global path
├── packages/
│   └── bundle          # Base Brewfile
└── docs/
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add package | `dot package add <name>` or edit `packages/bundle` |
| Vendor/update agent skill | `dot skills add <owner/repo> <skill...>` / `dot skills update` |
| Add global/deployed skill | Author `home/.agents/skills/<name>/SKILL.md`, then `dot skills sync` |
| Add repo-only maintenance skill | Author `.agents/skills/<name>/SKILL.md` |
| Shell alias | `home/.oh-my-zsh/custom/aliases.zsh` |
| Shell function | `home/.oh-my-zsh/custom/*.zsh` (git.zsh, worktree.zsh, utils.zsh) |
| Git alias | `home/.config/git/config` [alias] section |
| Starship prompt | `home/.config/starship.toml` |
| Pi extension | `home/.pi/agent/extensions/<name>/` |
| Pi skill (canonical) | `home/.agents/skills/<name>/SKILL.md` |
| Work git identity | Auto via `home/.config/git/work_config` for `~/Code/work/` |

## CONVENTIONS

- Stow layout: `home/` mirrors `~`, stow creates symlinks
- Zsh: oh-my-zsh; custom functions/aliases live in `home/.oh-my-zsh/custom/*.zsh`, loaded after plugins — check plugin aliases/functions before adding new ones (oh-my-zsh's `git` plugin already covers most git shorthand: `git_main_branch`, `git_current_branch`, `gbda`/`gbds`, `grename`, `gdv`, etc.)
- Agent skills: canonical copy lives in `home/.agents/skills/`; per-agent global dirs that differ from `~/.agents/skills/` (pi, Claude Code) get relative symlinks back to canonical, matching the `skills` CLI's own install behavior. Manage via `dot skills` (add/update/remove/sync/list) — never raw `skills add -g`/`skills update`, which target the wrong checkout, pollute the stow tree via `~/.config`, and fan out to every known agent. Vendored skills are tracked in `home/.agents/.skill-lock.json`; local shared skills (`mc-pr`, `mc-commit`, `bro`, `harness-routing`) are hand-authored and wired in with `dot skills sync`. Pi-only skills live under `home/.pi/packages/*/skills/`, not shared `~/.agents/skills/`
- Repo-local agent resources: maintenance guidance/tools that only make sense while editing this checkout live at repo root (`.agents/skills/<name>/SKILL.md`, `.pi/skills/<name>/SKILL.md`, `.pi/extensions/<name>/index.ts`). Do not put repo-maintenance-only resources under `home/`; canonical `dot apply` publishes `home/*` resources to real `~` paths.
- Pi extensions/packages: TypeScript, npm workspaces under `home/.pi/`; generic reusable local Pi packages live in `home/.pi/packages/` before publishing; published Pi packages live in `config/pi/settings.defaults.json`

## ANTI-PATTERNS

- Edit `~/.config/*`, `~/.zshrc`, `~/.oh-my-zsh/custom/*` directly (changes lost on stow)
- Hardcode paths (use `$DOTFILES_DIR`, `$HOME`)
- Nested git repos in stowed dirs (creates symlink issues)
- node_modules in stowed dirs (pi extensions exception — gitignored)

## COMMANDS

```bash
dot init              # Interactive bootstrap → apply → doctor
dot apply [--yes]     # Reconcile canonical checked-out desired state
dot update [--yes]    # Strict origin/main fast-forward → re-exec → apply
dot doctor            # Network-free repository-owned health report
dot package add X     # Record + install formula (use --cask explicitly)
dot package remove X  # Remove desired state only
dot skills update     # Update vendored agent skills to latest
dot skills sync       # Wire canonical skills into agent dirs
dot pi auth cloudflare  # Configure private provider auth
bun run --cwd tools/dot check  # Typecheck + tests
```

## KEY CONFIGS

| Tool | Entry | Notes |
|------|-------|-------|
| Zsh | `.zshrc` / `.zprofile` | oh-my-zsh bootstrap, EDITOR, tool inits (starship, zoxide, vp) |
| Git | `config` | SSH signing, `pull.rebase`, conditional include |
| Starship | `starship.toml` | 2s timeout (Vite+ shims) |
| Pi | `config/pi/settings.defaults.json` / `home/.pi/agent/model-families.json` | Tracked package/theme defaults sync to private runtime settings; role-routed model families |

## UNIQUE STYLES

- git: `fomo` = fetch origin main + rebase
- Theme: Catppuccin Macchiato across all tools

## NOTES

- `~/.dotfiles` is a clean deployment checkout on `main`; feature work belongs in worktrees
- `dot update` fetches and fast-forwards only; run broad `brew upgrade` / `pi update --all` explicitly
- Starship `command_timeout = 2000` because Vite+ node shims are slow
- `home/.oh-my-zsh/custom/secrets.zsh` is gitignored — contains env tokens for work services
- `.pi/agent/*` mostly gitignored; extensions + skills explicitly un-ignored; Pi runtime package settings are synced from `config/pi/settings.defaults.json`
- Git identity requires a clean `~/.gitconfig` (or none) — a pre-existing one overrides the XDG `~/.config/git/config` for any values it sets, breaking the personal/work conditional include
