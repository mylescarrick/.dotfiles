# Periodic test-suite review

A repeatable audit that removes low-signal tests without losing protection.

Run it when a suite has grown by agent-written unit tests, when test runtime is the critical path, or roughly once a quarter for a busy codebase.

## Harness

- **Pi:** run lanes inline one after another by default. Use `pi-subagents` for parallel lanes only when the suite is large enough to justify it and the package is available.
- **Claude Code:** use native subagents for lanes only when the suite is large enough to justify it.
- Pick models by role (`verification` for lanes, `planning` for coordinating), not by concrete model ID.

## 1. Baseline

From a clean tree, run the full suite. It must be green before you start. Then run it with coverage and record the test count per project plus line and branch coverage. Run with the same timezone and flags CI uses.

If a test category skips without setup (a database, say), measure through the command that provides that setup, or the baseline undercounts.

## 2. Unique-coverage map

Run each test file on its own with coverage and record, per file, the statements it covers and the statements **no other file covers**. This is slow on a big suite, so run it once and keep the output.

Zero unique statements means deleting the file costs no unique statement coverage. Branch coverage may still fall, and the file may still guard behavior, so check anyway. Many unique statements is a hint, not a reason to keep a test.

## 3. Fan out the audit

- **Scope:** unit tests only. Integration, workflow replay, and E2E tests are the higher boundary the audit compares against; leave them alone. If there is no automated higher boundary, say so in the brief: deletions must then stand on the test's own merits, not on "covered elsewhere".
- **Lanes:** split files into lanes of similar size by directory. Lanes own disjoint files.
- **Brief:** start from [lane-brief.md](lane-brief.md) and fill in the placeholders. Every lane gets the same brief.
- **Report:** each lane returns before/after counts (expand table-driven rows), a one-line reason class per file, kept tests with the regression each one guards, production seam candidates with grep evidence, registry removals, possible product bugs, and anything it was unsure about.

## 4. Coordinate

- Remove deleted files from shared registries.
- Re-verify every production-seam claim with a repo-wide `git grep -nw <symbol>`, then delete dead functions and drop test-only exports in one pass. Run lint and typecheck after.
- Spot-check the most aggressive lanes (>50% removed) by reading the removed test titles in the diff.
- Re-check judgement calls lanes flagged. Restore tests that guard privacy or security config, or deliberate-but-unwired domain rules, and ask the owner about deleting the module itself.
- Fix docs that name deleted tests (`git grep <basename>`, skipping archived plans).
- Report possible product bugs to the user. Do not fix behavior changes silently as part of a test cleanup.

## 5. Re-measure and gate

Run the full verification command and the coverage run again.

Defaults: remove at least 20% of tests and keep line coverage within 2 points of baseline. Adjust both to the repo. If coverage drops more, use the unique-coverage map to find which deleted file held the lost statements and decide whether that behavior deserves an integration test instead of restoring the unit test.

## Common low-signal patterns

- Call-shape assertions against mocked data access (`toHaveBeenCalledWith` on a `where` or `select`), unless the clause is itself the rule (a conditional update that stops stale writes, an authz or visibility filter) and no real-database test checks it
- Schema-validator, enum, and constant restatements
- Test files that re-implement the code under test inline and assert the copy
- Table-driven rows hitting the same branch
- Contract suites that validate hand-written fixtures instead of real serializer output

Reviewing the kept tests also surfaces product bugs that tests had pinned in place, so read what you keep, not just what you delete.
