# Dotfiles

Personal macOS development environment managed by `dot`.

GNU Stow publishes tracked files into `$HOME`, Homebrew manages packages, and
Bun runs the TypeScript CLI. The repository also configures Zsh, Git identities,
Pi, Claude Code, and a shared agent-skills library.

> For the terse, machine-oriented repository map, see `AGENTS.md`.

## Quick start

```bash
git clone https://github.com/mylescarrick/.dotfiles.git ~/.dotfiles
cd ~/.dotfiles
./dot init
```

`init` is intentionally interactive. If Bun is missing, the root launcher asks
before downloading the official Bun installer. The Bun application then:

1. installs Homebrew when missing;
2. installs Pi when missing;
3. optionally installs oh-my-zsh;
4. applies repository-declared state;
5. finishes with `dot doctor`.

Restart the shell, or run `source ~/.zshrc`, after first setup.

## Deployment checkout

`~/.dotfiles` is a deployment checkout. Keep it clean and on `main`; develop in
feature worktrees instead.

```bash
dot update
```

`update` fetches `origin`, permits only a clean fast-forward of the canonical
`~/.dotfiles` checkout on `main`, re-executes freshly fetched launcher/application code, then
runs the same reconciliation as `dot apply`. It never resets, cleans, stashes,
rebases, or silently discards local work.

Normal commands do not fetch. If `dot` itself is too broken to update, recover
with the deliberately small sequence:

```bash
git -C ~/.dotfiles fetch origin
git -C ~/.dotfiles merge --ff-only refs/remotes/origin/main
```

## The `dot` CLI

| Command | What it does |
|---|---|
| `dot init` | Bootstrap a new machine, apply desired state, then diagnose it |
| `dot apply [--yes]` | Reconcile the canonical checked-out state into the machine |
| `dot update [--yes]` | Strictly fast-forward canonical `main`, re-exec, then apply |
| `dot doctor` | Inspect repository-owned state without network access or repair |
| `dot package add NAME [--cask]` | Record sorted Brewfile state, then install it |
| `dot package remove NAME` | Remove desired Brewfile state without uninstalling |
| `dot skills [list]` | List canonical skills as local or vendored |
| `dot skills add REPO SKILL...` | Vendor skills into the current checkout |
| `dot skills update` | Update vendored skills in the current checkout |
| `dot skills remove SKILL...` | Remove local or vendored skills safely |
| `dot skills sync` | Rebuild relative Pi and Claude Code skill links |
| `dot pi auth cloudflare [OPTIONS]` | Configure private Pi Cloudflare auth |
| `dot help` / `dot --version` | Show command or version information |

`apply` validates the canonical checkout, validates skill links, installs only
missing Brewfile state, safely stows `home/`, synchronizes private Pi settings,
and runs `bun install` in `~/.pi` only when workspace state has drifted. It does
not run broad upgrades such as `brew upgrade` or `pi update --all`; invoke those
tools directly when wanted.

Without `--yes`, an interactive Stow conflict offers use/keep/diff/abort.
Noninteractive conflicts fail before mutation. `--yes` backs up conflicting live
files before tracked state wins; it never bypasses checkout safety.

## Repository structure

```text
~/.dotfiles/
├── dot                     # Small POSIX launcher/bootstrap
├── tools/dot/               # Bun/TypeScript application and tests
├── config/pi/               # Tracked defaults for private Pi runtime state
├── home/                    # Stowed to ~ (mirrors the home directory)
│   ├── .config/git/         # Personal/work Git identity split
│   ├── .agents/skills/      # Canonical shared skills library
│   ├── .pi/                 # Pi workspace and agent skill links
│   ├── .claude/skills/      # Claude Code skill links
│   ├── .oh-my-zsh/custom/   # Custom Zsh aliases and functions
│   └── .zshrc / .zprofile
├── packages/bundle          # Base Brewfile
├── docs/
└── AGENTS.md
```

Edit tracked files under `home/`, not their live `$HOME` symlinks, then publish
them from canonical `main` with `dot apply`. After merging a worktree change,
use `dot update` to refresh and publish it.

## Packages

```bash
dot package add ripgrep
dot package add raycast --cask
dot package remove ripgrep
```

Entries remain sorted within formula and cask groups. Addition records desired
state before installation, so a failed install remains visible to `dot doctor`
and is retried by `dot apply`. Removal only edits desired state; uninstall
explicitly with Homebrew if desired.

Manual Brewfile edits are also valid. `dot apply` checks them with Homebrew
auto-update disabled and installs only missing declared state with
`--no-upgrade`.

## Agent skills

`home/.agents/skills/` is canonical. Pi (`~/.pi/agent/skills/`) and Claude Code
(`~/.claude/skills/`) receive relative links back to it.

```bash
dot skills list
dot skills add mattpocock/skills wayfinder to-spec
dot skills update
dot skills remove tech-spec
dot skills sync
```

The wrapper scopes `HOME`, XDG directories, cache state, and target agents to the
current checkout. Do not call raw `skills add -g` or `skills update`: those can
write through live Stow links, target the wrong worktree, and fan out to
unrelated agents.

Vendored skills are tracked in `home/.agents/.skill-lock.json`; local shared
skills are hand-authored under `home/.agents/skills/`. Pi-only skills live under
`home/.pi/packages/*/skills/`.

See `docs/skills-maintenance.md` and `docs/agent-workflow.md` for maintenance and
workflow details.

## Pi private runtime state

`~/.pi/agent/settings.json` is a private regular file rather than a Stow link.
`dot apply`, `dot update`, and `dot init` merge tracked defaults from
`config/pi/settings.defaults.json`, preserving runtime preferences while letting
the repository own package sources. Writes are atomic and mode `0600`.

Configure Cloudflare providers with an environment resolver or 1Password
reference; `dot` does not read or log the underlying secret:

```bash
dot pi auth cloudflare \
  --account-id ACCOUNT \
  --gateway-id GATEWAY \
  --api-key-op-ref 'op://Private/Cloudflare Pi API Token/credential'

# Or:
dot pi auth cloudflare \
  --account-id ACCOUNT \
  --gateway-id GATEWAY \
  --api-key-env CLOUDFLARE_API_KEY
```

`~/.pi/agent/auth.json` preserves unrelated providers and is written atomically
at mode `0600`.

## Git identity and SSH keys

Git identity switches automatically by directory:

- default: `home/.config/git/config`;
- work paths under `~/Code/work/`: `home/.config/git/work_config`.

Commits use SSH signing keys referenced by those files. Generate missing keys
with native tooling, for example:

```bash
ssh-keygen -t ed25519 -C 'you@example.com' -f ~/.ssh/id_ed25519_example -N ''
```

A pre-existing `~/.gitconfig` can override XDG Git configuration. Remove or
empty competing values if identity selection is wrong.

## Verification and development

```bash
bun install --cwd tools/dot
bun run --cwd tools/dot check
```

The suite uses temporary homes, real local Git repositories/bare remotes, and
GNU Stow sandboxes. It does not call public Git remotes, package registries,
SSH agents, or real installers by default.

## Troubleshooting

**`dot update` refuses the checkout** — canonical `~/.dotfiles` must be clean,
on `main`, free of unfinished Git operations, and not ahead/diverged from
`origin/main`. Resolve Git state explicitly; `dot` will not guess.

**Package installation failed** — the package remains declared. Correct the
Homebrew problem, then run `dot apply`.

**Stow conflict** — rerun interactively to choose, or use `dot apply --yes` to
back up the live file under `backups/stow-conflicts/` before tracked state wins.
Backups remain available if GNU Stow later fails.

**Broken or drifted managed links** — `dot doctor` reports them; `dot apply`
reconciles fixable managed state.

**`command not found: dot`** — `source ~/.zshrc`, or ensure
`$HOME/.dotfiles` is on `PATH`; `.zprofile` in this repository configures it.

## License

Personal use. Fork and adapt freely.
