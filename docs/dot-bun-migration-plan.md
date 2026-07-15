# dot Bun Migration Plan

Status: Draft
Triage label: `ready-for-agent`
Owner: dotfiles maintainer
Scope: Convert the `dot` CLI from a monolithic Bash script into a modular Bun/TypeScript utility while preserving existing user-facing behavior.

## Testing Seams

The primary testing seam is the **black-box `dot` command** invoked against a sandboxed checkout and sandboxed home directory.

This seam validates the behavior that matters most: given a dotfiles checkout, a home directory, environment variables, terminal mode, and external tools on `PATH`, the CLI should produce the correct files, symlinks, output, exit codes, and subprocess calls.

Supporting seams:

1. **Pure core unit seam** — for deterministic logic such as Brewfile parsing, Pi settings merging, Pi auth merging, stow conflict planning, command parsing, and repository root discovery.
2. **Process adapter seam** — for fake subprocess execution, asserting exact argv, cwd, environment, captured output, and failure handling.
3. **Filesystem sandbox seam** — for validating symlink targets, backup contents, file permissions, atomic writes, and ignored generated artifacts.

The ideal test shape is high-level and behavioral. Internal module boundaries should be free to change as long as externally observable `dot` behavior remains correct.

## Problem Statement

The current `dot` CLI is a large Bash script that manages a personal macOS development environment. It works, but its size and responsibility mix make it increasingly hard to reason about, safely modify, and test.

The CLI currently combines command parsing, Homebrew orchestration, GNU Stow safety behavior, Pi runtime state sync, skills management, SSH key generation, update behavior, interactive prompts, file mutation, and subprocess execution in one place.

From the maintainer's perspective, the main problems are:

- Changes to one command can accidentally affect unrelated commands.
- Safety-sensitive filesystem behavior is difficult to unit test.
- Subprocess execution relies on shell parsing and `eval`-like behavior in places.
- Help text, README examples, parser behavior, and command implementation can drift.
- Some current documented behaviors do not quite match implementation behavior.
- First-run setup, update, and stow behavior are high-risk because they mutate the live home directory and system state.

The maintainer wants `dot` to stay simple to use, but become modular, idempotent, testable, and easier for agents or future contributors to modify safely.

## Solution

Replace the monolithic Bash implementation with a modular Bun/TypeScript CLI while preserving the public command name and user-facing behavior.

The root executable remains a tiny launcher/bootstrap. The Bun implementation lives in a dedicated tooling package outside the stowed home tree and outside the Pi workspace. The launcher resolves the actual checkout root, handles first-run Bun availability, and delegates to the TypeScript implementation.

The migration should be incremental. The new implementation should first cover command parsing, help/version, path resolution, pure local-state logic, and read-only commands. Higher-risk commands such as stow, init, update, package installation, and SSH key generation should be ported only after the test harness and lower-risk behavior are established.

The CLI should express desired state. Commands should be safe to rerun where possible. The migration should avoid adding many new options. Instead, it should clarify a small set of intentional controls, especially around noninteractive execution, optional setup steps, and destructive system changes.

## User Stories

1. As the dotfiles maintainer, I want `dot` to remain the single command for managing my environment, so that my daily workflow does not change.
2. As the dotfiles maintainer, I want the implementation to be modular, so that I can safely work on one command without understanding the entire CLI.
3. As the dotfiles maintainer, I want the CLI to be tested, so that I can refactor behavior without risking my live machine setup.
4. As the dotfiles maintainer, I want commands to be idempotent where practical, so that rerunning setup and sync commands is safe.
5. As the dotfiles maintainer, I want the CLI to avoid unnecessary options, so that commands describe desired state instead of historical repair paths.
6. As the dotfiles maintainer, I want `dot init --skip-ssh --skip-font` to work as documented, so that quick-start examples are reliable.
7. As the dotfiles maintainer, I want global options to work before or after the command where documented, so that the parser is predictable.
8. As the dotfiles maintainer, I want `dot` to resolve the checkout correctly when invoked through a symlink, so that `dot link` is safe.
9. As the dotfiles maintainer, I want `dot help` to be generated from command metadata, so that help text does not drift from implementation.
10. As the dotfiles maintainer, I want `dot --version` to continue working, so that scripts can detect the CLI version.
11. As the dotfiles maintainer, I want `dot doctor` to preserve its environment health checks, so that I can diagnose setup drift.
12. As the dotfiles maintainer, I want `dot update` to preserve its pull-and-reexec behavior, so that updated CLI code is used after pulling changes.
13. As the dotfiles maintainer, I want `dot update` to continue syncing packages, stow links, Pi settings, Pi extension dependencies, and configured Pi packages, so that the command remains the one-stop refresh path.
14. As the dotfiles maintainer, I want mutation commands to guard against running from the wrong checkout, so that worktrees do not accidentally repoint my live home symlinks.
15. As the dotfiles maintainer, I want `dot stow` to continue backing up conflicting live files, so that tracked dotfiles never destroy local state silently.
16. As the dotfiles maintainer, I want stow conflict behavior to remain understandable in interactive terminals, so that I can choose whether to use tracked or live files.
17. As the dotfiles maintainer, I want noninteractive stow behavior to be deterministic, so that automation does not hang or make ambiguous choices.
18. As the dotfiles maintainer, I want generated Pi dependency and build artifacts ignored by stow, so that live dependency trees are not replaced by symlinks.
19. As the dotfiles maintainer, I want Pi settings sync to preserve runtime model/provider preferences, so that my personal Pi choices are not overwritten.
20. As the dotfiles maintainer, I want dotfiles-owned Pi package defaults to override runtime package entries, so that package sources stay centrally managed.
21. As the dotfiles maintainer, I want old stowed Pi settings symlinks migrated to private runtime files, so that Pi can mutate runtime settings safely.
22. As the dotfiles maintainer, I want Pi auth setup to preserve existing auth entries, so that adding Cloudflare auth does not wipe other providers.
23. As the dotfiles maintainer, I want private Pi auth files written with restrictive permissions, so that secrets stay protected.
24. As the dotfiles maintainer, I want Cloudflare auth values to avoid leaking into logs and errors, so that sensitive values remain private.
25. As the dotfiles maintainer, I want package add/remove/list/update behavior preserved, so that Brewfile management remains convenient.
26. As the dotfiles maintainer, I want Brewfile edits to remain sorted and minimal, so that diffs stay readable.
27. As the dotfiles maintainer, I want missing package arguments to produce friendly usage errors, so that mistakes are easy to correct.
28. As the dotfiles maintainer, I want package operations to use safe subprocess calls, so that package names are never shell-interpolated.
29. As the dotfiles maintainer, I want failed package retry behavior preserved, so that setup remains resilient.
30. As the dotfiles maintainer, I want `dot skills` to operate on the current checkout, so that worktrees do not pollute the live home tree or unrelated agent directories.
31. As the dotfiles maintainer, I want skills to remain linked into Pi and Claude Code with relative symlinks, so that the canonical skills library remains shared.
32. As the dotfiles maintainer, I want local and vendored skills to remain distinguishable, so that skill maintenance remains clear.
33. As the dotfiles maintainer, I want SSH key generation to preserve the documented email-domain naming behavior, so that signing keys stay predictable.
34. As the dotfiles maintainer, I want any legacy SSH path inconsistency reviewed deliberately, so that migration does not silently change key behavior.
35. As the dotfiles maintainer, I want external command calls to be fakeable in tests, so that test runs are fast and safe.
36. As the dotfiles maintainer, I want default tests to avoid real Homebrew, Git remotes, SSH agent changes, Pi updates, and network installers, so that tests can run repeatedly without side effects.
37. As the dotfiles maintainer, I want a short legacy escape hatch during migration, so that I can recover if the new implementation misses an edge case.
38. As a future agent, I want clear command modules and core modules, so that I can make focused changes confidently.
39. As a future agent, I want tests at the highest useful seam, so that internal refactors do not require broad test rewrites.
40. As a future agent, I want implementation decisions captured in this plan, so that the migration can be completed systematically over multiple sessions.

## Implementation Decisions

- Keep the public command name as `dot`.
- Keep the root executable as a tiny launcher/bootstrap rather than making it the full application.
- Place the Bun implementation in a dedicated tooling package outside the stowed home tree.
- Do not place the new implementation inside the Pi workspace.
- Prefer source execution with Bun for the local checkout workflow.
- Treat compiled Bun binaries as optional future artifacts, not the primary installation or update mechanism.
- Preserve macOS as the supported operating system scope.
- Continue using Homebrew, GNU Stow, Git, SSH, Pi, and the skills CLI as external tools.
- Replace ad-hoc Bash dispatch with a typed command manifest.
- Generate root help and command help from command metadata where practical.
- Replace the delimited Bash init registry with typed init step definitions.
- Keep init step required/optional behavior explicit in the typed registry.
- Use argument-array subprocess execution for dynamic values.
- Avoid shell interpolation for package names, paths, provider IDs, and user-supplied values.
- Keep unavoidable shell-based remote installer behavior isolated, named, and easy to audit.
- Create pure core modules for deterministic transformations.
- Create adapters for filesystem, terminal IO, subprocess execution, and external tools.
- Inject adapters into command handlers so tests can use fakes.
- Preserve canonical-checkout mutation guards for commands that mutate the live home directory or canonical checkout.
- Support documented global flags before and after commands.
- Preserve existing interactive behavior unless explicitly changed.
- Preserve deterministic noninteractive behavior for automation.
- Keep GNU Stow as the tool that creates symlinks.
- Port the stow preflight/conflict/backup logic into TypeScript.
- Preserve generated-artifact ignore behavior for dependency trees, build outputs, caches, logs, platform files, and TypeScript build info.
- Preserve Pi settings as private runtime state rather than tracked stowed state.
- Preserve the rule that dotfiles-owned Pi package defaults override runtime package entries.
- Preserve Pi runtime preferences that are not dotfiles-owned.
- Preserve Pi auth as private runtime state with restrictive permissions.
- Preserve skills canonical storage and agent symlink behavior.
- Preserve the skills CLI isolation behavior so the wrapper writes into the intended checkout only.
- Preserve update self-reexecution after pulling a change to the CLI implementation.
- Keep a migration-era legacy implementation escape hatch until the new implementation has sufficient parity.
- Avoid adding broad new feature flags during the migration.
- Fix known mismatches between documentation and implementation as intentional compatibility improvements.

## Testing Decisions

- Test external behavior rather than implementation details.
- Use black-box CLI tests as the primary regression suite.
- Invoke the CLI against temporary checkouts and temporary home directories.
- Use fake executables on `PATH` for Homebrew, Git, GNU Stow, Pi, Bun-related commands, SSH tooling, clipboard tooling, and other external dependencies.
- Fake executables should record argv, cwd, environment, stdin, stdout, stderr, and exit status where relevant.
- Default tests must not call real Homebrew, real Git remotes, real network installers, real SSH agent commands, real Pi updates, or real package installation.
- Pure modules should have direct unit tests when they encode important deterministic rules.
- Filesystem tests should assert resulting files, symlink targets, backup contents, file modes, and absence of unintended mutations.
- Output tests should normalize timestamps, temporary paths, and ANSI color when those values are not semantically important.
- The existing stow conflict backup regression should remain covered.
- The existing stow generated-artifact ignore regression should remain covered.
- The existing Pi settings sync regression should remain covered.
- The existing Pi Cloudflare auth regression should remain covered.
- Add tests for root discovery through direct invocation and symlink invocation.
- Add tests for documented global option ordering.
- Add tests for missing argument validation in package commands.
- Add tests for command aliases and default subcommands.
- Add tests for generated help text containing all public commands and no malformed lines.
- Add tests for Brewfile sorted insertion, duplicate detection, removal, and special-character package names.
- Add tests for Pi settings merge semantics, including package ownership and symlink migration.
- Add tests for Pi auth upsert semantics, existing-entry preservation, key resolver formatting, and file mode.
- Add tests for stow conflict planning in interactive and noninteractive modes.
- Add tests for required versus optional init step failure handling.
- Add tests for update reexecution behavior when the CLI changes after pull.
- Add tests for skills checkout scoping and relative symlink creation.
- Add tests for SSH email/domain key naming.
- Maintain one canonical default test command for the Bun CLI.
- Keep real macOS/Homebrew smoke tests opt-in only.

## Execution Plan

### Phase 0 — Freeze the intended behavior

- Record the public command matrix.
- Record known intentional fixes:
  - documented post-command global flags should work,
  - symlink invocation should resolve the checkout root correctly,
  - missing package arguments should produce friendly errors,
  - malformed help output should be corrected,
  - Pi settings/auth should no longer require Node once handled by Bun,
  - legacy SSH key path behavior should be reviewed deliberately.
- Ensure current regression tests pass before starting the migration.

Acceptance criteria:

- Existing behavior is documented.
- Current regressions pass.
- Intentional behavior fixes are listed before implementation begins.

### Phase 1 — Introduce the Bun CLI skeleton

- Create a dedicated Bun package for the CLI implementation.
- Add a minimal command dispatcher.
- Add help/version support.
- Add a basic test setup.
- Keep the legacy Bash CLI as the default implementation initially.
- Add an opt-in path to exercise the Bun implementation during development.

Acceptance criteria:

- The new CLI can print help and version.
- The test command runs successfully.
- The legacy implementation remains usable.

### Phase 2 — Build shared primitives

- Implement repository root discovery.
- Implement command parsing.
- Implement output helpers.
- Implement prompt abstraction.
- Implement error and exit-code helpers.
- Implement filesystem adapter.
- Implement process adapter.
- Implement terminal adapter.
- Implement external-tool adapters.

Acceptance criteria:

- Direct and symlink invocation root discovery are tested.
- Global flags before and after commands are tested.
- Command dispatch and help are generated from command metadata where practical.
- Subprocess behavior can be faked in tests.

### Phase 3 — Port pure local-state logic

- Port Brewfile parsing and editing.
- Port Pi settings merge logic.
- Port Pi auth merge/upsert logic.
- Port stow ignore matching and conflict planning.
- Port SSH email/domain key-name derivation.

Acceptance criteria:

- Pure unit tests cover each deterministic transformation.
- Existing Pi settings and Pi auth regression behavior is reproducible through the new core logic.
- Brewfile insertion/removal preserves ordering and avoids duplicate entries.

### Phase 4 — Port read-only and low-risk commands

- Port root help and version.
- Port diagnostics.
- Port package listing/checking.
- Port skills listing.

Acceptance criteria:

- Commands run in black-box tests with fake external tools.
- No default test invokes real external package or network operations.
- Output is clear and behaviorally equivalent where intended.

### Phase 5 — Port deterministic mutating commands

- Port Pi settings sync.
- Port Pi auth Cloudflare setup.
- Port package add/remove Brewfile mutation.
- Port skills linking.
- Port global link/unlink behavior.

Acceptance criteria:

- Runtime Pi settings are preserved correctly.
- Dotfiles-owned Pi package defaults win correctly.
- Pi auth files are written with restrictive permissions.
- Package file edits are sorted and minimal.
- Skills symlinks are relative and scoped to the intended checkout.

### Phase 6 — Port stow behavior

- Port stow preflight conflict detection.
- Port conflict backup behavior.
- Port identical live file cleanup.
- Port generated-artifact ignore behavior.
- Preserve interactive conflict choices.
- Preserve deterministic noninteractive behavior.
- Invoke GNU Stow with explicit arguments.

Acceptance criteria:

- Stow conflict backup regression passes against the Bun implementation.
- Generated artifact ignore regression passes against the Bun implementation.
- Tests assert symlink results, backup contents, ignored files, and stow argv.

### Phase 7 — Port external system mutation workflows

- Port init.
- Port update.
- Port package update.
- Port failed package retry.
- Port SSH key generation.
- Preserve required/optional init step behavior.
- Preserve update self-reexecution behavior.

Acceptance criteria:

- Init step sequencing is tested with fake external tools.
- Required failures fail the command.
- Optional failures warn and continue.
- Update reexec behavior is tested.
- SSH key generation behavior is tested without touching the real SSH agent by default.

### Phase 8 — Make Bun the default implementation

- Replace the root executable body with a tiny launcher/bootstrap.
- Delegate to the Bun implementation by default when Bun is available.
- Preserve a legacy escape hatch for one migration window.
- Update README and agent-facing repo docs.

Acceptance criteria:

- `dot` invokes the Bun implementation by default.
- The launcher resolves the checkout root correctly through symlinks.
- Legacy fallback remains available temporarily.
- Documentation reflects the new implementation.

### Phase 9 — Remove legacy implementation

- Remove the legacy Bash implementation.
- Remove the legacy escape hatch.
- Ensure all tests exercise the Bun implementation.
- Keep behavior and architecture documentation current.

Acceptance criteria:

- The Bun implementation is the only implementation.
- Test suite is green.
- Docs no longer describe legacy behavior.

## Out of Scope

- Replacing Homebrew.
- Replacing GNU Stow.
- Replacing Git, SSH, Pi, or the skills CLI.
- Making the dotfiles manager cross-platform.
- Publishing the CLI to npm.
- Making compiled Bun binaries the primary installation path.
- Reorganizing the entire dotfiles repository beyond what the CLI migration requires.
- Reworking Zsh, oh-my-zsh, Git identity, Pi extension behavior, or skills content unless required by the CLI migration.
- Adding a large third-party CLI framework without a clear need.
- Adding broad new product features during the migration.

## Further Notes

This rewrite is primarily a compatibility-preserving migration. The simplification comes from clearer state ownership, typed command dispatch, pure core modules, and high-level behavioral tests — not from deleting large parts of the command surface immediately.

The highest-risk areas are:

1. stow conflict handling,
2. update self-reexecution,
3. skills checkout scoping,
4. Pi private runtime state,
5. external package/system mutation commands.

The safest starting point is the command manifest, path resolver, test harness, and pure local-state modules. The highest-risk external workflows should be migrated last.

## Open Decisions

- Whether the first-run launcher should bootstrap Bun automatically or print instructions when Bun is absent.
- Whether to keep a small set of noninteractive flags such as `--yes` or rely on existing prompt defaults.
- Whether to intentionally correct the legacy SSH default key path behavior during the migration or preserve it for compatibility.
- Whether to maintain old Bash regression scripts alongside Bun tests during the migration or port them immediately.
- Whether to add optional compiled binary output later for standalone distribution.
