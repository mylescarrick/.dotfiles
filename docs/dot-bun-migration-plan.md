# `dot` Bun Migration Plan

Status: Implemented — Phases 0–6 complete
Owner: dotfiles maintainer
Scope: Replace the monolithic Bash implementation with a small Bun/TypeScript CLI, while simplifying the command surface and making canonical-checkout updates safe and testable.

## Executive Decision

This is **not** a line-for-line Bash-to-TypeScript port.

The current `dot` script is 2,298 lines and combines repository updating, local state reconciliation, system bootstrap, package authoring, skills authoring, private Pi configuration, diagnostics, prompts, and recovery workflows. Recreating every function as a TypeScript command module would improve syntax without removing much complexity.

The migration will instead preserve the important state and safety invariants while reducing the public interface:

```text
dot apply                  Apply the checked-out desired state
dot update                 Refresh canonical origin/main, re-exec, then apply
dot doctor                 Inspect managed state without changing it
dot init                   Bootstrap a new machine, then apply

dot package add/remove     Safely edit the Brewfile
dot skills ...             Safely manage the checkout-scoped skills store
dot pi auth cloudflare     Safely update private Pi auth

dot help / --version
```

The root `dot` file remains a small, security-critical POSIX-compatible launcher because Bun may be absent on a new machine. Its only responsibilities are real-path resolution, the `update` prelude, explicit Bun bootstrap for `init`, and execution of the Bun application. The application lives in `tools/dot/` and should initially use Bun built-ins rather than a CLI framework.

`~/.dotfiles` is a **deployment checkout**: clean, on `main`, and used to publish configuration into `$HOME`. Development belongs in worktrees. Commands that mutate the repository for authoring may run in a worktree; commands that mutate live machine state may not.

## Freshness and `redot`

### Decision

Normal commands do not fetch from the network. `dot update` is the explicit freshness operation.

For `dot update` only, the launcher recognizes the command and performs the Git refresh **before** loading the Bun application. Every other command skips this prelude and performs no launcher-level network access.

1. Validate the small launcher-owned grammar (`dot update [--yes]`) before mutation; help bypasses the update prelude.
2. Require Bun to be available.
3. Require the launcher to resolve to the canonical `~/.dotfiles` checkout.
4. Require a clean checkout attached to `main`.
5. Fetch `origin`.
6. Compare `HEAD` with `refs/remotes/origin/main` and allow only equal or behind states.
7. Fast-forward with `git merge --ff-only refs/remotes/origin/main` when behind.
8. If `HEAD` changed, re-exec the refreshed launcher once.
9. Execute the Bun application from the refreshed revision and run `apply`.

This guarantees that the update workflow uses the revision just fetched from `origin/main`. It also fixes the current implementation's fragile rule of re-executing only when the root `dot` file changed; after the migration, any changed revision may change application behavior.

### Why not update on every launch?

A fetch on every invocation would make `help`, `doctor`, package editing, and local development sensitive to network latency, credentials, and outages. It would also mutate remote refs during commands that otherwise have no network behavior.

A live remote can change immediately after any fetch, so “always latest” can only mean “verified against the revision fetched at the start of this operation.” `dot update` provides that guarantee at an explicit point without slowing every command.

Before live-machine mutation, other commands still inspect local Git facts. If the canonical checkout is behind the **last-fetched** `origin/main`, they fail and recommend `dot update`. They must not claim that this proves remote freshness.

### Why not `redot`?

Do not add `redot` as a normal workflow. It would duplicate checkout-refresh knowledge, add another executable to install and test, and make callers choose between two commands that partly own the same invariant.

In particular, `redot` must not “clean” or reset the checkout. Automatic cleanup can silently destroy local work. Nor should a deployment checkout use `git pull --rebase`: it should contain no local commits to rebase. Dirty, ahead, detached, wrong-branch, and diverged states are errors requiring explicit human resolution.

If `dot` itself is too broken to update, the documented recovery is deliberately boring:

```bash
git -C ~/.dotfiles fetch origin
git -C ~/.dotfiles merge --ff-only refs/remotes/origin/main
```

An independently copied recovery tool should be added only if real failures show that these commands are insufficient. Recovery orchestration may be delegated later; the mutation guard must always remain inside `dot`.

## Intentional Command Surface

Command-specific options follow the command. Only `--help` and `--version` are global; the parser does not need to support options in every position.

| Exit | Meaning |
|---:|---|
| `0` | Success or already converged |
| `1` | Operational failure, refused unsafe mutation, or actionable `doctor` drift |
| `2` | Invalid command or arguments |
| `>2` | Reserved for unexpected launcher/application failures |

### Command behavior matrix

| Command | Checkout | Live home | System | Network | Prompt policy | Worktree policy |
|---|---|---|---|---|---|---|
| `help`, `--version` | Read root only | None | None | Never | Never | Allowed |
| `doctor` | Read local Git state | Read managed state | Read required tools | Never | Never | Allowed; reports whether checkout is canonical |
| `apply [--yes]` | Read and guard | Reconcile | Install missing declared state | Only when declared state is missing | Conflicts prompt on a TTY; `--yes` accepts tracked state after backup | Canonical checkout only |
| `update [--yes]` | Fetch and fast-forward, then read and guard | Same as `apply` | Same as `apply` | Always for Git; otherwise only missing declared state | Same as `apply` | Canonical checkout only |
| `init` | Read root | Reconcile via `apply` | Bootstrap missing prerequisites | As required for bootstrap and missing declared state | Interactive only | Canonical checkout only |
| `package add NAME [--cask]` | Atomically edit current checkout | None | Install the named package | Homebrew may use network | Never | Allowed |
| `package remove NAME` | Atomically edit current checkout | None | None | Never | Never | Allowed |
| `skills [list]` | Read current checkout | None | None | Never | Never | Allowed |
| `skills add/update/remove/sync` | Mutate current checkout | None | Run checkout-scoped skills tooling | Add/update may use network | Never | Allowed |
| `pi auth cloudflare` | Read provider rules | Atomically update private auth | None | Never | Prompts only for missing private inputs on a TTY | Allowed; always targets runtime `$HOME` explicitly |

All commands parse and validate their complete invocation before the first mutation. A command not listed in this matrix is not part of the intended interface.

### `dot apply [--yes]`

Reconcile the live machine with the canonical checked-out desired state.

It owns the ordered workflow behind one deep interface:

1. Validate canonical checkout state.
2. Inspect desired and live state before avoidable mutation.
3. Install missing declared packages only when the Brewfile is not satisfied.
4. Plan, back up, and apply stow changes.
5. Merge tracked Pi defaults into private runtime settings.
6. Synchronize canonical skill links.
7. Reconcile the stowed `~/.pi` workspace dependencies when required; the running `tools/dot` package does not install its own dependencies mid-execution.
8. Report completed, skipped, and failed stages.

If `HEAD` is behind the last-fetched `origin/main`, `apply` fails with guidance to run `dot update`. Equality only means “aligned with the last fetch”; `apply` never claims remote freshness.

It does **not** broadly upgrade Homebrew packages or run `pi update --all`. Those tools own their own upgrade behavior. `dot` owns convergence to repository-declared state.

A converged `apply` should be quick. Network access is allowed only when declared state is missing and requires installation; it must not occur merely to check for newer versions.

### `dot update [--yes]`

Refresh canonical `origin/main` through the launcher, re-exec if the revision changed, then invoke the same implementation as `dot apply`.

It replaces the current mixture of unconstrained `git pull`, optional broad Homebrew upgrades, stow, Pi sync, dependency install, and Pi upgrades. Update should be deterministic: refresh repository, then reconcile declared state.

### `dot doctor`

Read-only and network-free. Check only state owned or required by this repository:

- canonical checkout location, branch, cleanliness, and relation to last-fetched `origin/main`;
- required executables;
- Brewfile installation drift;
- managed symlink drift and conflicts;
- Pi runtime JSON validity and permissions;
- skills-link drift;
- configured SSH signing-key presence;
- broken links under managed paths, not an arbitrary scan of all `$HOME`.

Exit `0` when healthy and nonzero when actionable drift exists.

### `dot init`

First-run bootstrap only:

Before the Bun application can start, the launcher handles one special case: if Bun is missing and the command is `init`, it offers an explicit Bun bootstrap, then executes the Bun application. Initial bootstrap is intentionally interactive; noninteractive `init` is out of scope. For any other command, the launcher exits with one clear remediation instruction before changing the checkout.

The Bun-side init workflow is then:

1. Install Homebrew explicitly if missing.
2. Install Pi and other bootstrap-only tooling.
3. Install oh-my-zsh if missing.
4. Invoke the same implementation as `dot apply`; `apply` alone owns Brewfile package installation.
5. Finish with `dot doctor`.

Remote installer execution must be named, isolated, confirmed interactively, and never happen during ordinary commands. Required and optional stage policy must be explicit. Bun, Homebrew, and oh-my-zsh use their official HTTPS installer scripts, which do not provide a stable checksum contract for this workflow; TLS and the upstream host are therefore explicit trust dependencies. Download each script to a private temporary path before execution, remove it afterward, and pass the script an allowlisted environment rather than unrelated shell secrets.

SSH key generation leaves `dot`; documented `ssh-keygen` commands are clearer than the two inconsistent implementations currently in the script. Font installation is already owned by the Brewfile and must not be a duplicate init stage. Consequently, `--skip-ssh` and `--skip-font` disappear.

### `dot package add NAME [--cask]`

Atomically add a sorted Brewfile entry, then install it. Formula is the default; casks are explicit rather than network-detected.

If installation fails, the Brewfile remains the source of truth and `doctor` reports the drift. Dynamic values are always separate subprocess arguments.

### `dot package remove NAME`

Atomically remove a Brewfile entry. Do not unexpectedly uninstall the package; print the native `brew uninstall` command if useful.

The following existing package interfaces disappear:

- `package list`: inspect `packages/bundle` or use `doctor`;
- `package update`: use Homebrew directly;
- `check-packages`: merged into `doctor`;
- `retry-failed`: desired-state reconciliation replaces timestamped retry files;
- work-bundle arguments: there is no `packages/bundle.work`; add this only if a real second bundle appears.

### `dot skills`

Keep `add`, `update`, `remove`, `sync`, and the default `list` operation. This wrapper earns its interface because it hides real repository-specific policy:

- scoped `HOME` and temporary XDG/cache paths;
- restricted target agents;
- canonical versus vendored skill ownership;
- relative Pi and Claude Code links;
- ignored skills and dangling-link pruning;
- current-worktree isolation.

Rename implementation-oriented `link` to desired-state-oriented `sync`. Add/update/remove synchronize automatically.

### `dot pi auth cloudflare`

Keep the provider-specific operation because preserving unrelated auth, formatting key resolvers, redacting secrets, atomically writing JSON, and enforcing mode `0600` provide useful leverage.

Tracked Pi settings synchronization is no longer a public command; it is an implementation stage of `apply`.

### Commands removed

| Existing command | Replacement or reason |
|---|---|
| `stow` | Hidden inside `apply`; GNU Stow is an implementation detail |
| `pi-settings sync` | Hidden inside `apply` |
| `check-packages` | Included in `doctor` |
| `retry-failed` | Idempotent desired-state reconciliation |
| `package list/update` | Repository file, `doctor`, or native Homebrew |
| `gen-ssh-key` | Document native `ssh-keygen`; remove duplicate inconsistent implementations |
| `link` / `unlink` | `.zprofile` already puts `~/.dotfiles` on `PATH` |
| `edit` | `$EDITOR ~/.dotfiles` is clearer and equally capable |
| broad Homebrew/Pi upgrade workflow | Use `brew upgrade` and `pi update --all` directly |

No-argument `dot` shows help. Implicit mutation is not worth saving five characters.

## Safety Invariants

1. **Canonical deployment checkout** — live `$HOME` mutation is allowed only from the real `~/.dotfiles` checkout on `main`.
2. **No destructive Git repair** — never auto-stash, reset, clean, switch branches, or rebase local commits.
3. **Strict refresh** — `dot update` permits only equal or clean fast-forward states relative to fetched `origin/main`.
4. **Fresh implementation** — every changed update revision re-execs the launcher once before reconciliation.
5. **Parse before mutation** — invalid commands and arguments produce exit `2` without side effects.
6. **Plan before apply** — validate JSON and classify stow conflicts before avoidable mutation.
7. **Revalidate destructive actions** — a live file changed after planning is not moved or removed.
8. **Preserve conflicts** — differing live files are backed up before tracked state replaces them.
9. **Atomic private state** — Pi settings/auth writes use same-directory temporary files, atomic rename, and mode `0600`.
10. **No shell interpolation** — dynamic paths, package names, provider IDs, and user values are subprocess argv entries.
11. **Secret containment** — literal secrets never enter argv, subprocess environment, logs, or error messages.
12. **Idempotent recovery** — rerunning after partial failure resumes from observed desired/live state, not a retry sidecar protocol.
13. **Deterministic automation** — noninteractive execution never waits for input. Without `--yes`, a conflict requiring consent fails before changing that file.

Do not build a general transaction framework. Atomic private writes, stow precondition checks, unique backup directories, and a concise recovery message address the concrete failure modes.

## Architecture

### External seam

The primary module is the application:

```ts
interface DotApplication {
  execute(invocation: Invocation): Promise<CommandOutcome>;
}
```

Parsing, checkout policy, stage ordering, help generation, and error mapping sit behind this interface. The implementation returns an outcome rather than calling `process.exit` from command code.

Start with explicit `guardCanonicalCheckout()` calls in the few live-machine mutation workflows. Do not introduce a declarative effect system or general coordinator unless repetition in real commands demonstrates that it would remove more complexity than it adds.

### Deep internal modules

Organize by behavior, not one shallow file per command:

```text
tools/dot/
├── package.json
├── src/
│   ├── main.ts             # construct application and render outcome
│   ├── application.ts      # parse, guard, coordinate, dispatch
│   ├── checkout.ts         # read-only local Git-state classification
│   ├── apply.ts            # desired-state plan and stage orchestration
│   ├── stow.ts             # inspect → plan → resolve → revalidate → apply
│   ├── packages.ts         # Brewfile transforms and reconciliation
│   ├── pi.ts               # private settings/auth ownership and atomic writes
│   ├── skills.ts           # checkout-scoped skills policy
│   ├── diagnostics.ts
│   ├── process.ts
│   └── terminal.ts
└── test/
```

This is illustrative, not a required file-per-box structure. Merge files until a module actually owns meaningful policy.

### Earned seams only

Use:

- one process interface with production and recording adapters;
- one terminal interface with TTY and scripted adapters;
- a deep Git module above the process seam;
- real temporary filesystems and repositories;
- a narrow clock seam only if deterministic backup naming needs it.

Do **not** create pass-through Brew, Stow, Pi, SSH, clipboard, and filesystem adapters. Add a tool-specific seam only when it gains a second adapter or enough policy that deleting it would spread complexity across callers.

Pure in-process logic includes parsing, Brewfile transformation, Pi merge/upsert, stow planning, SSH-key presence rules, help rendering, and Git-state classification.

## Testing Strategy

The application interface is the main test surface. Critical launcher behavior is tested black-box.

### Application contract tests

Invoke `DotApplication.execute` with:

- a real temporary checkout and temporary home;
- the production rooted filesystem implementation;
- a recording process adapter;
- a scripted terminal adapter.

Assert observable files, symlink targets, modes, subprocess argv/cwd/environment, output, and exit status. Tests should survive internal file/module refactors.

### Launcher black-box tests

Cover:

- direct and symlink invocation;
- Bun missing behavior;
- canonical root enforcement;
- argument and stream forwarding;
- update re-execution into the newly fetched revision.

### Local tool contract tests

Use local bare Git repositories to cover equal, behind, ahead, diverged, dirty, detached, wrong-branch, fetch-failure, and fast-forward cases. Use real GNU Stow only against temporary homes. Default tests never call public Git remotes, Homebrew registries, Bun registries, Pi updates, SSH agents, or installers.

### Required regressions

Port the five existing shell regressions into the Bun suite:

- stow conflict backup;
- generated-artifact ignore;
- same-file behavior through a symlinked parent;
- Pi settings merge and old-symlink migration;
- Pi Cloudflare auth creation and mode.

Change the stow conflict fixture from Pi settings to a generic tracked file because Pi settings are now intentionally private runtime state.

Add coverage for:

- existing Pi auth provider preservation;
- invalid JSON preservation;
- atomic-write failure;
- interactive and noninteractive stow choices;
- file changes between stow planning and apply;
- Stow failure after backup;
- friendly package argument errors and special characters;
- generated help matching the command manifest;
- no secret values in output, argv, or environment;
- partial `apply` failure followed by a successful rerun;
- no broad Homebrew or Pi upgrades during `apply` or `update`.

Keep one canonical default test command. Real network/macOS bootstrap smoke tests remain opt-in.

## Execution Plan

### Phase 0 — Freeze the intentional contract

- Record the reduced command behavior matrix.
- Record network, prompt, mutation, and failure behavior per command.
- Convert current accidental defects into explicit fixes:
  - post-command flags currently do not work;
  - missing package arguments currently fail under `set -u` before friendly validation;
  - root help contains malformed output;
  - symlink invocation does not resolve the real checkout;
  - init and public SSH generation disagree on key paths;
  - font installation has duplicate ownership.
- Keep the five existing shell regressions green as baseline evidence.

Acceptance:

- The intended behavior is smaller than the current command surface.
- Every retained command has clear effects and ownership.
- Deletions and behavior changes are deliberate, not accidental migration gaps.

### Phase 1 — Build the harness and freshness launcher

- Create the dependency-light `tools/dot/` Bun package.
- Add `DotApplication.execute`, command metadata, generated help/version, process recording, and scripted terminal support.
- Add temporary checkout/home fixtures.
- Replace the root script with a migration launcher capable of strict `dot update` refresh and one-time re-exec.
- Test Git states with a local bare origin before any live update behavior is enabled.

Acceptance:

- Help and version work without network access.
- Direct and symlink launch resolve correctly.
- `dot update` never resets, cleans, rebases, or merges divergent work.
- A changed revision executes refreshed launcher/application code.

### Phase 2 — Deliver `dot apply` as a vertical slice

- Add the explicit canonical-checkout guard shared by live-machine workflows.
- Port stow inspect/plan/resolve/revalidate/apply behavior.
- Port Pi settings private-state synchronization with atomic writes.
- Port deterministic skills-link synchronization.
- Reconcile declared packages only when missing.
- Port existing regressions into Bun application tests, then remove equivalent shell tests rather than maintaining two suites.

Acceptance:

- `apply` is idempotent and canonical-only.
- Conflict backups, ignored artifacts, and symlink-parent safety are preserved.
- Noninteractive conflict policy is explicit and tested.
- A converged apply performs no broad upgrades.

### Phase 3 — Complete update and diagnostics

- Connect the refreshed launcher path to the same `apply` implementation.
- Implement network-free `doctor` over repository-owned state.
- Test fetch failure, no-change update, changed update, re-exec loop prevention, apply failure, and successful rerun.

Acceptance:

- `update` means exactly “strict fast-forward plus apply.”
- `doctor` reports actionable drift with useful exit status.
- No later system mutation occurs after a failed fetch or unsafe Git state.

### Phase 4 — Port retained authoring commands

- Implement package add/remove with atomic sorted edits and safe argv.
- Port skills add/update/remove/list/sync with checkout isolation.
- Port Pi Cloudflare auth upsert with atomic mode-`0600` writes and structural secret redaction.

Acceptance:

- Authoring commands work from feature worktrees without mutating live-home links.
- Package edits remain minimal and deterministic.
- Skills never pollute live symlinks or unrelated agent directories.
- Existing auth entries and environment fields are preserved.

### Phase 5 — Bootstrap last

- Implement explicit Bun bootstrap in the launcher's `init` path and Homebrew bootstrap in the Bun workflow.
- Install bootstrap-only tools, then delegate declared-state work to `apply` and `doctor`.
- Remove SSH generation and duplicate font setup.
- Test required versus optional failures without real installers.

Acceptance:

- Init is rerunnable.
- Every remote installer is isolated and confirmed.
- Routine commands never bootstrap tools silently.

### Phase 6 — Cut over and delete

- Make Bun the only implementation.
- Remove the legacy Bash implementation and escape hatch once the reduced contract passes.
- Update README and AGENTS.md to the reduced command surface and deployment-checkout model.
- Document the two-command manual Git recovery instead of adding `redot`.

Acceptance:

- One implementation, one generated help source, and one default test command remain.
- Deleted commands are absent from code and documentation.
- The canonical checkout can be refreshed and applied without running stale Bun code.

## Out of Scope

- Cross-platform support.
- Replacing Homebrew, GNU Stow, Git, Pi, or the skills CLI.
- Publishing to npm or making a compiled binary the primary installation path.
- A public plugin system or generic workflow engine.
- Automatic destructive repair of the canonical checkout.
- Automatic network refresh on every command.
- Broad package/tool upgrades.
- A standalone `redot` recovery tool without evidence that manual fast-forward recovery is inadequate.

## Review Evidence

At refresh time:

- the Bash implementation is 2,298 lines;
- the prior draft enumerated about 40 command-parity user stories;
- all five existing shell regressions pass;
- those regressions cover only stow and Pi private-state behavior, not parsing, checkout freshness, update re-execution, package authoring, skills, init, or diagnostics;
- `.zprofile` already adds `~/.dotfiles` to `PATH`;
- only `packages/bundle` exists;
- the Nerd Font is already declared in that Brewfile.

These facts support reducing the interface before porting it, and moving canonical-checkout freshness to the beginning of the migration rather than leaving it among the final high-risk workflows.
