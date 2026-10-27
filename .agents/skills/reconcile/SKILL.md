---
name: reconcile
description: Absorb machine drift (skills and Homebrew packages) reported by `dot reconcile` into this dotfiles worktree. Use only when started by `dot reconcile` with a drift report path.
disable-model-invocation: true
---

# Reconcile drift

`dot` found differences between this machine and the repo. You are in a fresh
worktree on a `reconcile/*` branch from `origin/main`. Your job: decide with the
user what each drift item means, edit the repo to match, and commit. `dot`
pushes and opens the PR after you exit.

Read [POLICY.md](POLICY.md) first. It describes how this machine should be
managed and settles most judgement calls.

## Hard rules

- **Only change paths in the report's `writeBackAllowlist`.** `dot` rejects the
  whole PR otherwise.
- **Never write to `~` or the canonical checkout.** Read from `homePath`, write
  to this worktree.
- **Never push, open PRs, or run `dot apply`.** `dot` does that after checking
  your commits.
- **Never edit vendored skill content.** Vendored skills change only through
  `skills/lock.json`.
- **Never run `brew install` or `brew uninstall`.** You edit `packages/bundle`;
  the user decides about the machine.
- **Leave the worktree clean.** Commit or discard everything before exiting.

## Loop

1. Read the drift report JSON. Skip items with `handled: true`.
2. For each item, one at a time: say what changed in one sentence, give your
   recommendation from POLICY.md, and ask with exactly these three answers:
   - **Add** it to the repo (you do this, then commit)
   - **Skip** for now (you do nothing; `dot` asks again next time)
   - **Ignore** it (tell the user to run `dot drift ignore NAME`; `dot` stops asking)

   Say "add", "skip" and "ignore" and nothing else: never "absorb", "leave as
   drift" or "snooze". Show a short diff for `modified-locally` or `conflict`
   (`diff -ru <repo copy> <homePath>`).
3. Apply the decision using the table below.
4. When every item is decided, commit with the `mc-commit` conventions, scope
   `skills` or `packages` (use the one that matches the changes). One commit is fine. Put the per-item decisions in the body.
5. Say which items were added, skipped or ignored. If they want a skipped item
   gone from this Mac instead, give the discard command from the table. Then
   tell them to exit Pi.

Never end a turn on a question and expect `dot` to carry on: if the user has not
answered, the session is still waiting on them, and quitting Pi means "no
commits". Ask, wait for the reply, then act.

"Absorb" in the tables below is what you do on **Add**. "Discard" is a separate
fourth option the user can ask for; give the command, never run it.

| Kind | Absorb | Discard (tell the user; do not do it) |
|---|---|---|
| `added-locally` | copy `homePath` to `skills/local/NAME` | `dot drift restore NAME` (removes it) |
| `vendored-added` | add `globalLockEntry` to `skills/lock.json` | `dot drift restore NAME` (removes it) |
| `vendored-updated` | replace the entry in `skills/lock.json` with `globalLockEntry` | `dot drift restore NAME` |
| `modified-locally` (local) | copy `homePath` over `skills/local/NAME` | `dot drift restore NAME` |
| `modified-locally` (vendored) | not allowed; recommend discarding | `dot drift restore NAME` |
| `deleted-locally` | remove `skills/local/NAME` or the lock entry | `dot drift restore NAME` |
| `conflict` | show the diff and merge by hand into `skills/local/NAME` | `dot drift restore NAME` |

Items with `domain: "brew"` are packages installed on the machine but not
declared in `packages/bundle`. Check `package` (`formula`, `cask` or `tap`):

| Kind | Absorb | Discard (tell the user; do not do it) |
|---|---|---|
| `installed-undeclared` | add `brew "NAME"`, `cask "NAME"` or `tap "NAME"` to `packages/bundle`, sorted among lines of the same type | `brew uninstall NAME` (add `--cask` for casks) |

When copying a lock entry, keep only `source`, `sourceType`, `sourceUrl`,
`skillPath` and `skillFolderHash`, and keep keys sorted by skill name.

Copy directories with `rsync -a --delete <homePath>/ skills/local/NAME/`.

## Done when

- `git status --porcelain` is empty
- `git diff --name-only origin/main...HEAD` lists only allowlisted paths
- the user knows which items were absorbed, left, or need a discard command
