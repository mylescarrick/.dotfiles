# Dotfiles

Personal macOS development environment, managed by a single CLI: `dot`.

Uses GNU Stow for symlinks, Homebrew for packages, and configures Zsh
(oh-my-zsh), Git (with a personal/work identity split), and AI coding agents
(`pi`, Claude Code) with a shared agent-skills library.

> For the terse, machine-oriented map of the repo, see `CLAUDE.md` / `AGENTS.md`.
> This README is the human setup and workflow guide.

## Quick start

```bash
git clone https://github.com/mylescarrick/.dotfiles.git ~/.dotfiles
cd ~/.dotfiles
./dot init                        # full setup
./dot init --skip-ssh --skip-font # skip optional steps
```

After `init`, `dot` is on your PATH globally. Restart the shell (or
`source ~/.zshrc`), then run `dot doctor` to verify.

> **Keep `~/.dotfiles` on `main`.** `dot` runs directly from the checkout, so a
> stale branch silently serves old behavior. Refresh with `dot update`.

## The `dot` CLI

| Command | What it does |
|---------|--------------|
| `dot init [--skip-ssh] [--skip-font]` | Full setup (see steps below) |
| `dot update` | Pull, upgrade Homebrew, re-stow, run `pi update` |
| `dot doctor` | Environment health check |
| `dot check-packages` | Show installed vs. missing Brewfile packages |
| `dot retry-failed` | Reinstall packages that failed during setup |
| `dot package add/remove/list/update` | Manage the Brewfile |
| `dot gen-ssh-key [email]` | Generate an ed25519 SSH key (named by email domain) |
| `dot stow` | Re-create `home/` → `~` symlinks |
| `dot link` / `dot unlink` | Add/remove the global `dot` symlink in PATH |
| `dot edit` | Open the dotfiles dir in `$EDITOR` |
| `dot help` | Command overview |

`dot init` runs, in order: Homebrew → Brewfile packages → Stow → Bun →
`pi` (via `bun install -g`) → pi extension deps → SSH key (`--skip-ssh`) →
Nerd Font (`--skip-font`) → oh-my-zsh. Package installs are resilient:
failures are logged to `packages/failed_packages_*.txt` and retried with
`dot retry-failed`.

## Repository structure

```
~/.dotfiles/
├── dot                     # The CLI
├── home/                   # Stowed to ~ (mirror of your home dir)
│   ├── .config/
│   │   ├── git/            # config + work_config (conditional include)
│   │   ├── ghostty/        # Terminal
│   │   ├── ripgrep/        # rg config
│   │   └── starship.toml   # Prompt
│   ├── .agents/skills/     # Canonical agent-skills library
│   ├── .pi/                # pi workspace (extensions, skill symlinks)
│   ├── .oh-my-zsh/custom/  # Custom zsh: aliases, git, worktree, utils
│   ├── .local/bin/         # Personal scripts (agent-repos, coffee)
│   ├── .zshrc / .zprofile
│   └── .ssh/allowed_signers
├── packages/bundle         # Base Brewfile
├── CLAUDE.md / AGENTS.md   # Instructions for AI agents
└── README.md
```

Edit files under `home/` (never `~` directly — stow owns those symlinks), then
`dot stow` to apply.

## Git identity

Identity switches automatically by directory via a conditional include:

- **Default** (everywhere): personal identity in `home/.config/git/config`
- **Work**: anything under `~/Code/work/` uses `home/.config/git/work_config`

Commits are SSH-signed. The signing keys are per-identity
(`~/.ssh/id_ed25519_gmail.pub`, `~/.ssh/id_ed25519_knox.pub`); generate them
with `dot gen-ssh-key <email>`.

> A pre-existing `~/.gitconfig` overrides the XDG `~/.config/git/config` for any
> values it sets. Remove or empty it so the conditional include takes effect.

## Agent skills

`home/.agents/skills/` is the canonical store (mostly vendored from
[mattpocock/skills](https://github.com/mattpocock/skills), plus a few local
ones). Agents whose global skills dir is `~/.agents/skills/` share it directly.

Agents with their own global dir — `pi` (`~/.pi/agent/skills/`) and Claude Code
(`~/.claude/skills/`) — get each skill mirrored in as a relative symlink back to
`.agents/skills/`, matching the [`skills`](https://skills.sh) CLI's own install
mode.

Manage them with `dot skills`, which wraps the CLI so it always writes into the
current checkout — never the live `~` symlinks, the wrong worktree, or 50+
unrelated agent dirs — and keeps its cache/config out of the stow tree:

```bash
dot skills list                                   # vendored vs local
dot skills add mattpocock/skills wayfinder to-spec  # vendor third-party skills
dot skills update                                 # update all vendored skills
dot skills remove tech-spec                        # drop a skill
dot skills link                                    # wire local skills (mc-pr, …) into agents
```

Vendored (third-party) skills are tracked in `home/.agents/.skill-lock.json`;
local skills (`mc-pr`, `mc-commit`, `bro`) are hand-authored under
`home/.agents/skills/` and wired into agents with `dot skills link`.

Skills changes follow the normal flow: commit the diff and open a PR. Once it's
merged, publish to `$HOME` with `dot update` (pulls `main` + re-stows) — or, if
you'd rather skip the Homebrew/pi prompts, `git -C ~/.dotfiles pull && dot stow`.
A bare `dot stow` only re-links what's already checked out, so it won't pick up a
merged PR on its own. (If you edit directly in `~/.dotfiles` instead of via a
branch, `dot stow` alone is enough.)

> **Don't** call `skills add -g` / `skills update` directly — from a worktree it
> writes into `~/.dotfiles` (your `main` checkout), on the canonical checkout it
> pollutes the stow tree via `~/.config`, and without `-a pi claude-code` it
> fans out to every known agent. `dot skills` handles all three.

## Packages

```bash
dot package list                 # list everything in the bundle
dot package add ripgrep          # add a formula (type auto-detected)
dot package add raycast cask     # add a cask
dot package remove ripgrep       # remove from the bundle
dot package update [name]        # upgrade all / one package
dot check-packages               # what's installed vs. missing
```

Entries stay alphabetically sorted per type. Adding a package installs it
immediately. Manual edits to `packages/bundle` are fine too — apply with
`brew bundle --file packages/bundle`.

## Troubleshooting

**`dot doctor` shows stale results / old behavior** — your `~/.dotfiles` is
likely on an old branch. Put it on `main` and refresh:
```bash
git -C ~/.dotfiles checkout main && dot update
```

**`command not found: dot`** — `source ~/.zshrc`, or ensure
`export PATH="$HOME/.dotfiles:$PATH"` is in `~/.zprofile`.

**Package install failures** — `dot check-packages`, then `dot retry-failed`.

**Broken symlinks** — `dot doctor` reports them; `dot stow` re-creates links.

**Git identity is wrong** — check for a competing `~/.gitconfig`:
`cat ~/.gitconfig`.

**pi missing** — reinstall with `bun install -g @mariozechner/pi-coding-agent`.

## License

Personal use. Fork and adapt freely.
