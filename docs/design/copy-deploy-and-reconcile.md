# Copy deployment and agent reconcile

Status: implemented. Skills and everything under `home/` deploy by copy; Homebrew, Bun and Pi package drift is reported too. Stow is gone.

## Problem

Stow makes `~` and the canonical checkout the same files. Anything that writes to
its own config (`skills update -g`, Pi, a hand edit to `~/.zshrc`) writes into
`~/.dotfiles` and leaves local `main` dirty. Guarding the checkout can't fix
that while the symlinks exist.

Separately, every way of changing desired state today is a bespoke `dot`
subcommand (`dot skills add`, `dot package add`, `dot bun add`). Installing
something the normal way leaves the repo silently out of date.

## Principles

1. **The canonical checkout is read-only source.** Nothing outside `git` writes
   to it. `dot` only ever fast-forwards it.
2. **`dot` copies into `~`; it never links into the checkout.** Tools are free to
   rewrite what they own.
3. **The repo stores declarations, not artifacts.** Vendored skills are a lock
   entry (source + git tree hash), not a copy of the files.
4. **Code decides what is true; the agent decides what to do about it.** Drift
   detection is deterministic. The agent only does judgement work and edits a
   worktree.
5. **Applying never destroys a local change.** Anything ambiguous becomes drift.

## Repository layout (skills)

```
skills/
├── lock.json        # vendored skills: skills CLI lock entries, stable fields only
├── external.json    # names installed by other tools; linked, never reported
└── local/<name>/    # hand-authored shared skills
```

`lock.json` keeps only `source`, `sourceType`, `sourceUrl`, `skillPath` and
`skillFolderHash`. The CLI's `installedAt`/`updatedAt`/`lastSelectedAgents`
churn stays in `~`.

`skillFolderHash` is a git tree ID, so `git archive <hash>` from the source repo
reproduces the skill byte-for-byte (verified against `mattpocock/skills`).
Fetched trees are cached under `$XDG_CACHE_HOME/dot/skills/<hash>`, so a warm
cache needs no network. `dot doctor` stays network-free and reports uncached
skills instead of fetching them.

## Deployed layout

| Path | What `dot` writes |
|---|---|
| `~/.agents/skills/<name>/` | real directory, copied |
| `~/.pi/agent/skills/<name>` | `../../../.agents/skills/<name>` |
| `~/.claude/skills/<name>` | `../../.agents/skills/<name>` |
| `~/.agents/.skill-lock.json` | real file; `dot` merges vendored entries in |

This matches what `skills add -g -a pi claude-code` produces, so the skills CLI
and `dot` agree on layout. Keeping the global lock populated means
`skills update -g` works normally, and its edits surface as drift.

## Dotfiles (`home/`)

Every tracked file under `home/` is copied to the same path in `~` and recorded by hash
(`.zshrc`, `.config/git/config`), using the same three-way rule as skills at file
granularity. `git ls-files home` defines the set, so untracked and ignored files are never
touched. Executable bit is kept; a new `~/.ssh` is created `0700`.

- **First-run migration** replaces stow's links. A link to a tracked file becomes a real
  copy (same content, so no drift). A folded directory link becomes a real directory:
  content with tracked files is copied, content only this Mac has (herdr's
  `session.json`, an untracked extension) is *moved* out of the checkout. A link that
  leaves the checkout is refused.
- **`dot apply --yes`** replaces a file that differs from the repo, after copying the old
  one to `~/.local/state/dot/backups/<time>/`. Without it, such files stay as drift.
- Drift kinds are `modified-locally`, `conflict` and `deleted-locally`. `dot drift restore
  PATH` redeploys one file (with a backup).

## Deploy record

`$XDG_STATE_HOME/dot/deployed.json` (default `~/.local/state/dot/`):

```json
{
  "version": 1,
  "entries": { ".agents/skills/tdd": { "hash": "sha256:…" } },
  "handled": { "modified-locally:tdd:sha256:…": "2026-10-26T…" }
}
```

`hash` is a sha256 over the sorted relative paths, executable bit and contents
of every file in the directory. `handled` holds drift fingerprints already sent
to a PR, so `dot` doesn't ask twice. A fingerprint includes the current hash,
so a further local change re-surfaces.

## Drift rules

For each skill name: **D** = repo version, **R** = last deployed, **C** = what's
in `~` now.

| D | R | C | Action |
|---|---|---|---|
| yes | – | absent | install |
| yes | yes | absent | drift `deleted-locally` |
| yes | any | = D | in sync (re-record) |
| yes | = C | ≠ D | update (repo changed, `~` untouched) |
| yes | = D | ≠ D | drift `modified-locally` |
| yes | other/– | ≠ D | drift `conflict` |
| no | yes | absent | forget record |
| no | = C | present | remove (repo dropped it) |
| no | ≠ C | present | drift `conflict` |
| no | – | present | drift `added-locally` (unless in `external.json`) |

Refinements using the skills CLI's global lock:

- `modified-locally` on a vendored skill whose global lock hash differs from
  the repo lock becomes **`vendored-updated`** (someone ran `skills update -g`).
- `added-locally` with a global lock entry becomes **`vendored-added`**.

Old stow links (any symlink resolving into `<checkout>/home/`) count as
absent, so the first run migrates them without prompting.

## Commands (spike)

| Command | Does |
|---|---|
| `dot apply` | as before; skills now deploy by copy with the rules above |
| `dot drift` | prints the drift report as JSON (may fetch uncached skills) |
| `dot drift ignore [NAME]` | stops asking about drift: all of it, or one item. A skill is asked about again if its content changes; a package has nothing to change, so it stays ignored |
| `dot drift restore NAME` | overwrites `~` with the repo version, or removes a skill the repo lacks (discards drift) |
| `dot reconcile` | drift → ask → worktree → Pi agent → guard → push → PR |

The `dot skills …`, `dot package add/remove` and `dot bun add/remove` authoring commands are removed. Install skills however you
like (`bunx skills add -g … -a pi claude-code`, or write one in
`~/.agents/skills/`) and `dot reconcile` absorbs it.

Outdated packages: a launchd job (`dev.dotfiles.outdated`, every 6 hours, written by
`dot apply` for the real login account only) runs `dot outdated --refresh`, which does
`brew update` then `brew outdated`, and compares Bun globals and Pi packages against the
npm registry. Results go to `~/.local/state/dot/outdated.json`, so bare `dot` lists them
instantly. Each source is checked on its own; one failing keeps its previous result and
is reported. Bare `dot` asks about upgrading at most once a week (`upgradeOfferedAt` in
the deploy record); `dot upgrade` stays for forcing it.

Bare `dot` is the everyday command: the launcher fast-forwards canonical `main`
(as `update` does), then `apply`, then `reconcile` if there is drift.
Non-interactive runs print the drift summary and exit 0 without starting the
agent. `dot help` replaces the old no-argument help, and `apply`, `update` and
`upgrade` stay for the cheap or broader single steps. Bare `dot` takes no flags,
so a stow conflict in a non-interactive run still needs `dot apply --yes`.

## Reconcile flow

1. Build the drift report; drop already-handled fingerprints. Nothing left →
   exit.
2. Ask before starting the agent (interactive only).
3. `git fetch origin main`, then a worktree on `reconcile/<timestamp>` from
   `origin/main` under `<parent of checkout>/.dotfiles-worktrees/`.
4. Write the report to `$XDG_STATE_HOME/dot/drift-report.json`.
5. Start Pi interactively in the worktree (`--approve`, so Pi does not ask to trust
   every new worktree) with the repo-local
   `.agents/skills/reconcile` skill and the report path. The agent asks one
   question at a time, edits `skills/`, and commits. It does not push. When
   done it calls `reconcile_finish`, a tool from `.pi/extensions/reconcile-finish`
   that `dot` loads with `-e`, which ends the session so nobody has to quit Pi.
6. After Pi exits, `dot` checks the agent's commits **mechanically**:
   - the worktree is clean
   - every changed path is on the allowlist (`skills/`, `packages/bundle`, `packages/bun-global`, `config/pi/settings.defaults.json`)
   - `gitleaks` passes, if installed
7. Push, then open the PR with a title and body `dot` writes itself from the items
   the branch actually settles (read from `skills/lock.json`, `skills/local/` and
   `packages/bundle`), never from the agent's commit text. Only those items are
   marked handled, so anything the user skipped is asked about again. Remove the
   worktree.

If the agent made no commits, `dot` says so and leaves the drift. Not asking again is the separate `dot drift ignore [NAME]`, never a follow-up prompt: a second yes/no right after the agent's own question reads as its answer, and "yes" means the opposite.

## Known gaps

- **The agent's shell is restricted, not sandboxed.** While `dot reconcile` runs Pi it
  sets `DOT_RECONCILE=1`, which switches on `.pi/extensions/reconcile-guard`. That
  blocks `git push|remote|config`, `--no-verify`, `gh`, `sudo`, installs and removals
  (`brew`, `bun/npm -g`, `pi`, `skills`), `dot apply|update|reconcile|drift restore`, and any
  `rm`, `mv`, `cp`, `rsync`, `tee`, `ln`, `sed -i`, `git -C` or `>` redirect whose target is
  outside the worktree (temp files are allowed); the `write` and `edit` tools get the same
  path rule. A script the agent writes can still do anything, so `dot` also checks
  afterwards that `main` did not move, the canonical checkout is untouched, and the branch
  was not pushed early, on top of the path allowlist, clean tree and gitleaks. Without
  `DOT_RECONCILE` the extension does nothing, so ordinary Pi sessions in this repo are
  unaffected.
- **`deleted-locally` never auto-restores.** Use `dot drift restore NAME` or let
  the agent drop it from the repo.
- **Dotfile drift is per file, and noisy files will nag.** A file a tool rewrites
  often (herdr's `.plugins.lock`) shows as drift whenever its content changes, because
  the fingerprint includes the hash. Untrack such files rather than ignoring them.
- **A dotfile can hold secrets.** The agent copies `~/<file>` into `home/<file>` when
  absorbing it, so it must read the file first and refuse inline tokens (the policy
  says to move them to the gitignored `secrets.zsh`). gitleaks and the PR review are
  the backstop.
- **Links dropped from the repo are not swept.** Old stow links to files since deleted
  from `home/` are left dangling; there is no list of them to prune.
- **Package drift is report-only.** Packages installed but undeclared are absorbed
  into the tracked file for their tool: Homebrew (read from `brew bundle cleanup`, a
  dry run) into `packages/bundle`, global Bun packages into `packages/bun-global`, and
  Pi packages into `config/pi/settings.defaults.json`. There is no deploy record,
  because each tool already converges declared state. `dot apply` no longer deletes
  Pi packages installed by hand: it lists tracked packages first and keeps the rest,
  so they surface as drift instead of vanishing. A package the repo once declared
  looks the same as a new one, so the agent checks `git log -S` before re-adding.
