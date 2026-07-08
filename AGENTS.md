# DOTFILES

macOS dev env via GNU Stow. Zsh (oh-my-zsh) + Git + pi.

## STRUCTURE

```
.dotfiles/
├── dot                 # CLI: init/update/doctor/stow/package
├── home/.config/       # Stowed to ~/.config/
│   ├── git/            # Conditional work config
│   ├── ghostty/        # Terminal
│   ├── starship.toml   # Prompt (2s timeout for Vite+)
│   └── ripgrep/        # rg config
├── home/.zshrc, .zprofile  # Stowed to ~
├── home/.oh-my-zsh/custom/ # Custom zsh functions/aliases (stowed into ~/.oh-my-zsh/custom/)
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
- Agent skills: canonical copy lives in `home/.agents/skills/`; per-agent global dirs that differ from `~/.agents/skills/` (pi, Claude Code) get relative symlinks back to canonical, matching the `skills` CLI's own install behavior
- Pi extensions: TypeScript, npm workspaces under `home/.pi/`

## ANTI-PATTERNS

- Edit `~/.config/*`, `~/.zshrc`, `~/.oh-my-zsh/custom/*` directly (changes lost on stow)
- Hardcode paths (use `$DOTFILES_DIR`, `$HOME`)
- Nested git repos in stowed dirs (creates symlink issues)
- node_modules in stowed dirs (pi extensions exception — gitignored)

## COMMANDS

```bash
dot init              # Full setup (brew, stow, bun, ssh, font, oh-my-zsh)
dot update            # Pull + brew upgrade + restow + pi update
dot doctor            # Health check
dot stow              # Resymlink only
dot package add X     # Add + install package
dot gen-ssh-key       # Generate ed25519 key by email domain
```

## KEY CONFIGS

| Tool | Entry | Notes |
|------|-------|-------|
| Zsh | `.zshrc` / `.zprofile` | oh-my-zsh bootstrap, EDITOR, tool inits (starship, zoxide, vp) |
| Git | `config` | SSH signing, `pull.rebase`, conditional include |
| Starship | `starship.toml` | 2s timeout (Vite+ shims) |
| Pi | `settings.json` | Default provider: opencode.cloudflare.dev, Catppuccin theme |

## UNIQUE STYLES

- git: `fomo` = fetch origin main + rebase
- Theme: Catppuccin Macchiato across all tools

## NOTES

- `dot update` handles WARP VPN brew API issues automatically
- Starship `command_timeout = 2000` because Vite+ node shims are slow
- `home/.oh-my-zsh/custom/secrets.zsh` is gitignored — contains env tokens for work services
- `.pi/agent/*` mostly gitignored; extensions + skills explicitly un-ignored
- Git identity requires a clean `~/.gitconfig` (or none) — a pre-existing one overrides the XDG `~/.config/git/config` for any values it sets, breaking the personal/work conditional include
