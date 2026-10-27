# Lane brief template (periodic test review)

Copy, then replace every <PLACEHOLDER>.

Repo:    <REPO PATH>
Package: <PACKAGE DIR> (run all commands from here)
Tooling: <PACKAGE MANAGER AND RUNNER, e.g. the one the repo's scripts use; never mix managers>
Lane:    <LIST OF TEST FILES THIS LANE OWNS>

## Goal

Delete every unit test that would not catch a real bug that an end-to-end or integration test would miss.
Prefer a smaller suite that protects behavior over a large suite that protects coverage numbers.
Program-wide target: remove >= <TARGET>% of all <N> tests while keeping merged line coverage within <TOLERANCE> points of <BASELINE>%.
Your lane is expected to carry its share: be decisive. Do NOT pad numbers either: every deletion must meet the rubric below.

## Keep a test only if ALL are true

1. It protects an observable behavior, invariant, or public contract (request handler response, API payload shape,
   workflow outcome, database write, authz decision, date math that users see, parser output for real input).
2. There is a credible regression that would make it fail (name it in one line).
3. Existing E2E or integration coverage does not already catch that failure (check <HIGHER-BOUNDARY TEST DIRECTORIES>
   and other unit tests at a higher boundary).
4. It would survive a behavior-preserving refactor. If it breaks only because an internal name, call shape, or mock changed, delete it.

## Delete on sight

- Tests that restate the code they were written after (e.g. asserting a constant equals its literal, a mapper copies field X to X,
  `expect(fn).toHaveBeenCalledWith(<exact internal args>)` as the main assertion). Exception: a query filter that IS the rule
  (a conditional update guarding ordering or idempotency, an authz or visibility filter) stays unless a real-database test checks it.
- Assertion-free coverage probes (`not.toThrow()` only, render-only, `toBeDefined()` on an import).
- Source, import, or string greps (reading source files, checking a route file contains a string, export-exists checks).
- Mocks that implement the behavior being asserted (the mock returns the answer and the test checks the mock's answer).
- Expected values produced by the code under test (snapshots or expectations computed by calling the same function).
- Tests whose only purpose is to keep a test-only export, wrapper, or seam alive.
- Near-duplicates of a stronger test at a higher boundary (same behavior already asserted in an integration test, or several
  cases that vary only trivially: keep the 1-2 that cover distinct branches, drop the rest; collapse table rows that hit the same branch).
  "Same branch" is a claim about production code: open it and confirm. Each `case` of a `switch` or each operator in a
  mapping table is its own branch (`<` and `<=` are not duplicates of `>` and `>=`).

## Hard rules

- Read each candidate test AND its production owner before deleting it.
- Do not delete a failing test to make the suite green. If a test you would KEEP fails, stop and report it as a possible product bug.
- Do not edit production code (<PRODUCTION DIRECTORIES>). If deleting tests leaves a production export or seam that exists only for tests
  (e.g. `__testing`, `_internal`, an `export` used only by tests), list it under "Production seam candidates" with file:line and the
  exact grep evidence that only tests use it. The coordinator removes production code.
- Only edit files in YOUR lane list. Other lanes are editing other files concurrently. Do not touch git (no commit, stash, checkout, reset).
- When deleting a whole file: remove it, and if it is listed in a shared registry (<SHARED REGISTRIES, e.g. a test file manifest>),
  do NOT edit the registry; list it under "Registry removals" in your report (the coordinator edits it to avoid conflicts).
- After removing tests from a file, remove now-unused imports, helpers, in-file fixtures, and empty `describe` blocks.
  Shared fixtures and utilities: do not delete; list them if they became unused.
- Follow the repo's formatter and lint config.

## Data you can use

- <UNIQUE-COVERAGE MAP PATH>: per test file, statements covered, statements covered by NO other test file, and the top production
  files of those unique statements. A file with zero unique statements contributes no unique coverage; deleting it costs nothing
  on coverage (still check behavior). High unique counts are a hint, not a reason to keep: coverage is not behavior.
- <PER-FILE COVERAGE DETAIL PATH> if you need statement-level detail.
- Higher-boundary tests live in <HIGHER-BOUNDARY TEST DIRECTORIES>.

## Verification (once, at the end)

Run <SCOPED TEST COMMAND> on every remaining file in your lane. Paste the summary lines.
If it is too slow, run in 2-3 batches. Confirm the files you edited still pass and no unused imports are left.

## Report

Before/after counts (expand table-driven rows), a one-line reason class per file, kept tests with the regression each one guards,
Production seam candidates, Registry removals, possible product bugs, and anything you were unsure about.
