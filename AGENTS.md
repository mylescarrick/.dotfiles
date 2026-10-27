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
├── home/.pi/           # Pi agent workspace (AGENTS.md)
│   ├── agent/extensions/ # TypeScript extensions
├── skills/             # Shared skills, copied (not stowed) to ~/.agents/skills/
│   ├── lock.json       # Vendored: pinned git tree hashes, contents fetched
│   ├── external.json   # Installed by other tools; linked only
│   └── local/<name>/   # Hand-authored
├── packages/
│   └── bundle          # Base Brewfile
└── docs/
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add package | `dot package add <name>` or edit `packages/bundle` |
| Add global Bun package | `dot bun add <name>[@version]` or edit `packages/bun-global` |
| Vendor/update agent skill | `bunx skills add -g <owner/repo> -s <skill> -a pi claude-code` / `bunx skills update -g -y`, then `dot reconcile` |
| Add global/deployed skill | Author `~/.agents/skills/<name>/SKILL.md`, then `dot reconcile` (or add `skills/local/<name>/` in a worktree) |
| Add repo-only maintenance skill | Author `.agents/skills/<name>/SKILL.md` |
| Shell alias | `home/.oh-my-zsh/custom/aliases.zsh` |
| Shell function | `home/.oh-my-zsh/custom/*.zsh` (git.zsh, worktree.zsh, utils.zsh) |
| Git alias | `home/.config/git/config` [alias] section |
| Starship prompt | `home/.config/starship.toml` |
| Pi extension | `home/.pi/agent/extensions/<name>/` |
| Shared output style | `home/.claude/output-styles/Attention-kind.md` |
| Claude Code default style | `home/.claude/settings.defaults.json` |
| Lint/format rules | `biome.jsonc` at repo root |
| Pi skill (canonical) | `skills/local/<name>/SKILL.md` |
| Work git identity | Auto via `home/.config/git/work_config` for `~/Code/work/` |

## CONVENTIONS

- Stow layout: `home/` mirrors `~`, stow creates symlinks
- Zsh: oh-my-zsh; custom functions/aliases live in `home/.oh-my-zsh/custom/*.zsh`, loaded after plugins — check plugin aliases/functions before adding new ones (oh-my-zsh's `git` plugin already covers most git shorthand: `git_main_branch`, `git_current_branch`, `gbda`/`gbds`, `grename`, `gdv`, etc.)
- Agent skills: sources live in `skills/` (`local/` hand-authored, `lock.json` vendored by git tree hash, `external.json` installed by other tools). `dot apply` **copies** them into `~/.agents/skills/` and gives Pi and Claude Code relative links, matching the `skills` CLI layout — nothing in `~` links into the checkout, so tool writes never dirty `main`. Change skills in `~` (raw `bunx skills add -g … -a pi claude-code` / `skills update -g` are fine now) and run `dot reconcile` to absorb the drift into a PR. Never edit vendored content; it changes only via `skills/lock.json`. Pi-only skills live under `home/.pi/packages/*/skills/`, not shared `~/.agents/skills/`. Design: `docs/design/copy-deploy-and-reconcile.md`
- Repo-local agent resources: maintenance guidance/tools that only make sense while editing this checkout live at repo root (`.agents/skills/<name>/SKILL.md`, `.pi/skills/<name>/SKILL.md`, `.pi/extensions/<name>/index.ts`). Do not put repo-maintenance-only resources under `home/`; canonical `dot apply` publishes `home/*` resources to real `~` paths.
- Pi extensions/packages: TypeScript, npm workspaces under `home/.pi/`; generic reusable local Pi packages live in `home/.pi/packages/` before publishing; published Pi packages live in `config/pi/settings.defaults.json`
- Lint/format: Ultracite (Biome preset) is configured once at the repo root and covers both `tools/dot` and `home/.pi` TypeScript. The root `package.json` is tooling-only — it is not stowed and is not a workspace root for the nested Bun workspaces. Rules marked `"warn"` in `biome.jsonc` are a pre-existing backlog, not permanent exemptions; `"off"` marks deliberate disagreements with the preset.

## ANTI-PATTERNS

- Edit `~/.config/*`, `~/.zshrc`, `~/.oh-my-zsh/custom/*` directly (changes lost on stow)
- Hardcode paths (use `$DOTFILES_DIR`, `$HOME`)
- Nested git repos in stowed dirs (creates symlink issues)
- node_modules in stowed dirs (pi extensions exception — gitignored)

## COMMANDS

```bash
bun run lint          # Ultracite/Biome check across the checkout
bun run format        # Apply safe lint + format fixes
dot                   # Update → apply → reconcile drift (the everyday command)
dot init              # Interactive bootstrap → apply → doctor
dot apply [--yes]     # Reconcile canonical checked-out desired state
dot update [--yes]    # Strict origin/main fast-forward → re-exec → apply
dot upgrade [--yes]   # Update → optional Homebrew upgrade → stale cask repair → Bun self-upgrade → Pi update --all
dot doctor            # Network-free repository-owned health report
dot package add X     # Record + install formula (use --cask explicitly)
dot package remove X  # Remove desired state only
dot drift             # Skill drift between ~ and the repo, as JSON
dot reconcile         # Absorb drift into a PR via the Pi reconcile agent
dot pi auth cloudflare  # Configure private provider auth
bun run --cwd tools/dot check  # Typecheck + tests
```

## KEY CONFIGS

| Tool | Entry | Notes |
|------|-------|-------|
| Zsh | `.zshrc` / `.zprofile` | oh-my-zsh bootstrap, EDITOR, tool inits (starship, zoxide, vp) |
| Git | `config` | SSH signing, `pull.rebase`, conditional include |
| Starship | `starship.toml` | 2s timeout (Vite+ shims) |
| Pi | `config/pi/settings.defaults.json` | Tracked package/theme defaults sync to private runtime settings |
| Shared output style | `home/.claude/output-styles/Attention-kind.md` | Loaded by Pi extension and Claude Code; canonical Attention-kind body |
| Claude Code | `home/.claude/settings.defaults.json` | Default `outputStyle` synced to `~/.claude/settings.json` |

## UNIQUE STYLES

- git: `fomo` = fetch origin main + rebase
- Theme: Catppuccin Macchiato across all tools

## NOTES

- `~/.dotfiles` is a clean deployment checkout on `main`; feature work belongs in worktrees
- `dot update` fetches and reconciles only; `dot upgrade` explicitly owns broad Homebrew/Pi upgrades
- Starship `command_timeout = 2000` because Vite+ node shims are slow
- `home/.oh-my-zsh/custom/secrets.zsh` is gitignored — contains env tokens for work services
- `.pi/agent/*` mostly gitignored; extensions + skills explicitly un-ignored; Pi runtime package settings are synced from `config/pi/settings.defaults.json`
- Git identity requires a clean `~/.gitconfig` (or none) — a pre-existing one overrides the XDG `~/.config/git/config` for any values it sets, breaking the personal/work conditional include
