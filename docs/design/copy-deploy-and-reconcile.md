# Copy deployment and agent reconcile

Status: spike. Skills deploy by copy; Homebrew drift is reported too. The rest of `home/` is still stowed.

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

The `dot skills …` authoring commands are removed. Install skills however you
like (`bunx skills add -g … -a pi claude-code`, or write one in
`~/.agents/skills/`) and `dot reconcile` absorbs it.

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
   - every changed path is on the allowlist (`skills/`, `packages/bundle`)
   - `gitleaks` passes, if installed
7. Push, then open the PR with a title and body `dot` writes itself from the items
   the branch actually settles (read from `skills/lock.json`, `skills/local/` and
   `packages/bundle`), never from the agent's commit text. Only those items are
   marked handled, so anything the user skipped is asked about again. Remove the
   worktree.

If the agent made no commits, `dot` says so and leaves the drift. Not asking again is the separate `dot drift ignore [NAME]`, never a follow-up prompt: a second yes/no right after the agent's own question reads as its answer, and "yes" means the opposite.

## Known gaps

- **The agent has `bash`, so the guard can't stop it pushing itself.** The guard
  runs on the path `dot` controls. Running Pi with a restricted toolset is the
  follow-up.
- **`deleted-locally` never auto-restores.** Use `dot drift restore NAME` or let
  the agent drop it from the repo.
- **Stow still folds directories.** `~/.config/herdr`, `ghostty` and `ripgrep`
  are single links into the checkout today, which is why herdr's
  `session.json` has to be gitignored. Skills deploy refuses to write through
  a folded path. Adding `stow --no-folding` fixes the rest but unfolds every
  folded directory, so it ships as its own change.
- **Only skills move to copy deployment.** The rest of `home/` is next, using
  the same record and rules.
- **Package drift is report-only.** Homebrew packages installed but undeclared
  are read from `brew bundle cleanup` (a dry run) and absorbed into
  `packages/bundle`; there is no deploy record because `brew bundle` already
  converges declared state. Bun globals and Pi packages had no drift on the
  first machine inspected, so they are not covered yet.
