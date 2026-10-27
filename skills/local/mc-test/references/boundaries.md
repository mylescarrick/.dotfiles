# Test boundaries and tooling

Stack-neutral setup rules for the boundaries in `SKILL.md`. The repo's own test docs and scripts win on any conflict.

## Find scoped commands before running the whole suite

Before a full test run, check the package's scripts and any `TESTING.md` for a scoped command: one file, tests related to a changed source file, or tests changed since the default branch. A whole-suite run for a one-file change wastes the feedback loop those wrappers protect. Run the whole suite at a commit, PR, or ship boundary, not on every edit.

If a documented scoped command is missing or broken, fix the script rather than falling back to the whole suite and moving on.

## Real database

Use a real database for SQL, constraints, triggers, and authz or visibility filters. Mocked query calls and substrings of a query string prove nothing about the rule.

- **Own environment variable.** Use a dedicated `TEST_DATABASE_URL`, never the one dev and deploy tooling read. Refuse a non-loopback host if tests truncate or delete.
- **Skip locally, fail in CI.** Skip the suite when the URL is unset, but make CI throw when it is unset so a green run can't mean "skipped".
- **Throwaway server for local runs.** Start a temporary instance on a free port, apply the real migrations (not a schema push, which can skip CHECK constraints and triggers), run the tests, then remove it.
- **Isolation.** Use a unique prefix per test when queries can be scoped. Queries that read a whole table need a reset per test and serial files.
- **Assert the outcome.** Read back through the app's own functions against literal expected values. Before trusting a new suite, break each rule in the SQL once and watch the matching test fail.

## Outbound HTTP, time, randomness

- No real network requests. Block them at the test runner level so a leak fails loudly, and fail the test if a registered interceptor was never hit.
- No wall-clock waiting. Freeze or inject time, and trigger scheduled work directly.
- Seed randomness, or inject the source.
- Consume response bodies fully so one test's leftovers can't leak into the next.

## Authentication

Where login goes through an external identity provider, use a mocked or seeded session in automated tests and ask the user to verify the real flow manually.

## Layout and shape

Keep dense pure-logic tests in a `unit/` area and put the database, workflow, and E2E tests in their own areas, so the boundary is obvious from the path. Use Arrange/Act/Assert with blank-line separation. Check the neighbouring tests for the closest existing pattern before writing a new file from scratch.
