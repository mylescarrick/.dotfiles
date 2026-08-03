# Herdr + Sprites

A proposal for replacing Supacode's role (repos, worktrees, tabs, surfaces) with
[Herdr](https://herdr.dev) as the workspace/agent multiplexer, and optionally moving
execution onto [Fly.io Sprites](https://sprites.dev) as persistent remote sandboxes.

Pi stays the harness. Nothing here changes the coding-agent loop.

## Why these two

**Herdr** is a Rust terminal multiplexer (`tmux`, but agent-aware). It keeps each
agent in a real pane, classifies panes as `idle`/`working`/`blocked`/`done`, and
exposes a socket API plus a plugin system. Two properties make it a direct fit here:

- **`pi` is a first-class agent kind.** Supported kinds are `pi`, `claude`, `codex`,
  `gemini`, `cursor`, `devin`, `agy`, `cline`, `omp`, `mastracode`, `opencode`,
  `copilot`, `kimi`, `kiro`, `droid`, `amp`, `grok`, `hermes`, `kilo`, `qodercli`,
  `maki`. So Pi is detected, not bolted on.
- **`herdr integration install pi` installs a Pi TypeScript extension**
  (`herdr-agent-state.ts`) that reports lifecycle state over the socket API using
  `HERDR_PANE_ID` / `HERDR_SOCKET_PATH`. That is hook-based state, which is far more
  accurate than screen-pattern matching — and it is the same extension mechanism this
  repo already uses in `home/.pi/agent/extensions/`.

Herdr also owns worktrees natively: `herdr worktree create|open|remove` creates the
checkout, opens it as a workspace, and groups it with the parent repo's workspace.
That is the Supacode job, done by the multiplexer.

**Sprites** are hardware-isolated Firecracker VMs — persistent Linux boxes (up to
8 CPU / 16 GB RAM) that hibernate when idle and wake on demand, with filesystem
checkpoints. They ship with Claude Code, Codex, Gemini, `gh`, Node, Go, Python and
Git preinstalled. Notably **not** Pi, so Pi is something we provision.

## The two topologies

The important decision is *where Herdr runs*.

### A. Herdr local, each pane a `sprite console`

Panes run `sprite console -s <name>`; the agent runs in the sprite.

- Simple, no sshd, local UI latency.
- **But** Herdr's process inspection can't see remote processes, so only screen-pattern
  detection works — the accurate hook path breaks, because `HERDR_SOCKET_PATH` is a
  local unix socket the sprite cannot reach.
- `herdr worktree create` is local, but the worktrees are in the sprite. Wrong side.

### B. Herdr *inside* the sprite, local Herdr as a thin remote client — recommended

Herdr's `--remote` mode makes the local terminal a thin client that connects over SSH,
starts or attaches the remote server, and streams the UI back. Detach with `prefix+q`;
panes keep running.

- Agents, worktrees, git, and the Herdr socket all share one filesystem → full
  detection fidelity, working `herdr integration install pi`, and native
  `herdr worktree create`.
- The persistence semantics line up exactly: Herdr detach/reattach ↔ sprite
  hibernate/wake. Close the laptop; the agents keep running; reattach later.
- **Caveat:** Sprites do not expose SSH. You must run an SSH server inside the sprite
  and tunnel it through `sprite proxy`. That is the one real cost of this topology.

**Recommendation: B**, with A as the zero-setup escape hatch for quick one-offs. B is
the only option where Pi's state hooks and Herdr's worktree management both work, and
it is the only one that actually replaces Supacode rather than half-replacing it.

Until the sshd-in-sprite step is verified, `sprite-dev attach` implemented here uses the
A-style console path — it is useful immediately and does not block on the tunnel.

## Sprite granularity: one per repo, not per branch

Worktrees inside a single sprite are nearly free; sprites are not. So:

- one sprite per **repo** (or per workstream), named for the repo;
- many worktrees inside it, each its own Herdr workspace;
- a **golden checkpoint** as the base image, restored into new sprites.

This is the main cost lever — a hibernating sprite costs little, and one sprite hosting
six worktrees beats six sprites hosting one each.

## Auth, and why the existing `dot` design already solves it

Pi auth in this repo resolves secrets through 1Password (`op://...`) references. Inside a
sprite there is no `op` session, so `op://` refs cannot resolve.

`dot` already supports the alternative: `dot pi auth cloudflare --api-key-env` and
`dot pi auth exa --api-key-env` write an `$ENV_NAME` resolver instead of an `op` command.
So the sprite story is:

1. read the secret from 1Password **locally**, at provisioning time;
2. inject it into the sprite as an environment file (`~/.config/sprite-dev/env`, mode `0600`);
3. provision Pi auth with the `--api-key-env` variants.

No secret is committed, and no new `dot` capability is needed.

**Take the golden checkpoint before injecting secrets.** Checkpoints capture the
filesystem; a golden image with credentials baked in is a golden image you cannot share
or rebuild safely.

The AI CLIs' OAuth flows (Claude, Codex, Gemini) redirect to your local browser and work
from a remote sprite. `gh` needs its own `gh auth login` inside the sprite.

## Provisioning

`home/.local/bin/sprite-dev` wraps the lifecycle. `sprite-dev provision` installs, inside
the sprite: Bun, Pi, Herdr, oh-my-zsh, then clones this repo and stows `home/` with the
same GNU Stow invocation `dot` uses, then runs `herdr integration install pi`.

It deliberately **does not** run `dot apply` by default. `dot apply` drives Homebrew, and
`packages/bundle` is macOS-oriented — the casks (`claude-code`, `1password-cli`, `raycast`,
`discord`, fonts) cannot install on Linux, so the run would fail partway. Stowing the tree
directly gets the agent surface (`.pi`, `.agents/skills`, git config, zsh customs) without
the package manager. Pass `--full` to attempt `dot apply --yes` anyway.

Closing that gap properly is the follow-up below.

## Migration from Supacode

Supacode owned repos/worktrees/tabs/surfaces. Herdr covers all four:

| Supacode role | Herdr equivalent |
|---|---|
| repo/workspace switching | `herdr-plus` Projects (fuzzy-pick a declarative workspace template) |
| worktree creation | `herdr worktree create` / `open` / `remove`, natively grouped with the parent repo |
| per-worktree tab layout | `herdr-plus` worktree auto-layouts, fired on `worktree.created` / `worktree.opened` |
| multiple surfaces | Herdr tabs and panes (up to 4 panes per tab) |

`herdr-plus` (`herdr plugin install cloudmanic/herdr-plus`) is what makes this a real
replacement rather than a downgrade — it adds declarative workspace templates and, more
importantly, **worktree auto-layout**: create a worktree and its tabs open with commands
already running, no keypress.

Run both for a period. Nothing here removes Supacode; `docs/agent-workflow.md` and the
`harness-routing` skill now name Herdr as the preferred surface with Supacode as the
incumbent.

## Config added to this repo

| Path | Purpose |
|---|---|
| `packages/bundle` | `brew "herdr"` |
| `home/.config/herdr/config.toml` | extended: terminal, theme, ui, prefix, plugin-action bindings |
| `home/.config/herdr-plus/config.toml` | `[worktree] branch_prefix = "myles/"` |
| `home/.config/herdr-plus/worktrees/default.toml` | wildcard worktree auto-layout that starts Pi |
| `home/.local/bin/sprite-dev` | sprite lifecycle + dotfiles provisioning + checkpoints |

### Herdr keybindings

The prefix is `ctrl+b` (tmux muscle memory). Bound plugin actions:

| Key | Action |
|---|---|
| `prefix+p` | `cloudmanic.herdr-plus.projects` — project workspace picker |
| `prefix+a` | `cloudmanic.herdr-plus.quick-actions` — quick action launcher |

Reload config in a running session with `prefix+Shift+r`, or `herdr server reload-config`.

### Worktree auto-layout

`home/.config/herdr-plus/worktrees/default.toml` uses `repo = "*"`, so every repo without
a specific layout gets the same shape: a Pi pane, a review pane, and a shell. Add
`repo = "<name>"` files beside it to specialise. The switch is whether the file exists.

Note `herdr-plus` reads its config from Herdr's **managed** plugin directory
(`herdr plugin config-dir cloudmanic.herdr-plus`) when running under Herdr, and falls back
to `~/.config/herdr-plus/`. The tracked files here use the fallback path, which is also the
path the worktree-layout docs specify. Verify with `herdr plugin config-dir` on first run
and symlink the managed directory at the tracked one if they differ — do not let Stow fight
a directory Herdr provisions.

## Verify before trusting

The `herdr.dev`, `sprites.dev` and `fly.io` doc sites are unreachable from this
environment (proxy policy), so parts of this were reconstructed from the `@fly/sprites`
npm package, the `home-manager` Herdr module, the `herdr-plus` and `herdr-file-viewer`
plugin repos, and secondary write-ups. Confirm these before relying on them:

- **`sprite` CLI flag names.** `sprite-dev --dry-run` prints every command it would run;
  diff that against `sprite <cmd> --help`. Verified forms: `sprite create <name>`,
  `sprite exec -s <name> -- <cmd>`, `sprite console -s <name>`,
  `sprite checkpoint create -s <name>`, `sprite restore <label> -s <name>`,
  `sprite proxy <local>:<remote>`, `sprite auth setup --token`, `sprite list`,
  `sprite destroy`. Unverified: the exact selector flag on `destroy` and `proxy`.
- **Herdr config keys.** Everything written here comes from the `home-manager` module's
  own example (`terminal.{default_shell,shell_mode,new_cwd}`,
  `theme.{name,auto_switch,light_name,dark_name}`,
  `ui.{sidebar_width,agent_panel_sort,toast.delivery,sound.enabled}`, `keys.prefix`,
  `[[keys.command]]`). Keys I could not confirm — notably
  `show_agent_labels_on_pane_borders` and the `[agents]` / `[session]` sections — are
  deliberately omitted rather than guessed, since a stray key can fail config parsing.
  Check `herdr.dev/docs/config-reference/` and add them deliberately.
- **`herdr-plus` requires Herdr ≥ 0.7.0.**
- **The `herdr-file-viewer` action name.** A `prefix+f` binding for
  `herdr plugin install smarzban/herdr-file-viewer` is intentionally not included; its
  action id was truncated in the source I could read.

## Follow-ups

1. **A Linux/sprite profile for `dot`.** The real gap. Either split `packages/bundle` into
   a base Brewfile plus a macOS-cask overlay, or teach `dot apply` to skip casks and
   Homebrew off-macOS. That turns `sprite-dev provision` into a plain `dot init` and gives
   sprites genuine dotfiles parity.
2. **sshd + `sprite proxy` for topology B**, then switch `sprite-dev attach` to
   `herdr --remote`. This unlocks Pi state hooks and native worktrees.
3. **Pi package sync in sprites.** `dot apply` merges `config/pi/settings.defaults.json`
   into private runtime settings; provisioning currently skips that step.
4. **A `herdr` Pi extension**, if `herdr integration install pi` proves insufficient —
   the socket API is available and this repo already builds Pi extensions.
