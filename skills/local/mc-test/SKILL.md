---
name: mc-test
description: Testing doctrine — decide whether a test is worth writing, where it belongs, and when to delete one. ALWAYS use before writing, adding, extending, reviewing, or deleting tests, when a plan's verification step mentions tests, when a test fails after a change, or when the user mentions test quality, coverage, flaky tests, low-signal tests, or test cleanup.
---

# MC Test

A test is a liability until it catches a bug. The suite exists to protect behavior, not coverage numbers. Prefer a smaller suite of strong tests at real boundaries over a large suite that restates the implementation.

This skill decides **whether** and **where** to test. The `tdd` skill runs the red-green loop once you know (good vs bad tests, mock only at system boundaries: [tdd/mocking.md](../tdd/mocking.md)). Boundary setup (real database, outbound HTTP, time) and finding the repo's scoped test commands are in [references/boundaries.md](references/boundaries.md).

## The rules

1. **Never write unit tests after you write code.** A test written to match finished code restates it and passes by construction.
2. **Highly prefer E2E or integration tests as the sole testing mechanism.** Use them to verify complex features work. At the end, produce a **verifiable and repeatable artifact**.
3. **If you must test a system in isolation, first write down all the ways it could fail, then write the code.** Each test maps to one listed failure mode.
4. **A test that breaks under a behavior-preserving refactor is asserting implementation, not behavior.** Do not add it.
5. **Never delete or weaken a failing test to make the suite pass.** Fix the code, or ask. A failing kept test is a possible product bug until proven otherwise.

## Choosing the boundary

Pick the highest boundary that runs fast and deterministically:

| Boundary | Use for |
|---|---|
| Browser/E2E | User-visible flows across routes, from a seeded session |
| Database integration | Real writes, constraints, SQL, authz over real rows |
| Background job or workflow replay | Steps, retries, scratch state, idempotency |
| Composition smoke | Several real modules composing end to end |
| Isolated unit | Only after rule 3: dense pure logic (date math, parsers, policy tables) with many real edge cases |

Find the repo's existing test at each boundary and copy its setup before inventing one.

## Verifiable, repeatable artifacts

The end of an E2E or integration test should leave evidence a reviewer can re-check without trusting the test author:

- the response payload, or state read back through the app's own read path, asserted against literal expected values from the spec or a worked example (query raw rows only when the database state is itself the contract, e.g. raw SQL or a migration)
- a deterministic output file (rendered document, CSV/export payload, print package) asserted field by field or written to a known path
- a browser screenshot or accessibility snapshot from a seeded, deterministic session

Same inputs must produce the same artifact on every run: seed data, freeze time, no real network.

## Failure-mode list (rule 3)

Write this in the PR description or task notes before the code:

```
System: <function/module and its public contract>
Ways it could fail:
1. <input/edge> -> <wrong observable outcome>
2. ...
Covered by higher boundary already: <which, or none>
Tests to write: <fewest tests that fail for every uncovered mode>
```

Failure modes are not a test count. Drop a mode only when another test's assertion makes it impossible (a test asserting the exact output list makes a second test of its length redundant). Be strict: "appears once" does not prove "counted once" if the count could be computed before the merge. Cases guarding the same rule belong in one test.

If every failure mode is already caught at a higher boundary, write no unit test. The remaining failure modes are the seams you agree with the user before starting the `tdd` loop.

## Budget check before committing new tests

Count them. For each, name in one line the regression that only it catches. Merge or delete any you can't. Then break the code on purpose for each one: a test that still passes isn't guarding anything (already-sorted input can't prove a sort; all-equal values can't prove an order of operations).

## Keep a test only if all are true

- It protects an observable behavior, invariant, or public contract.
- There is a credible regression that would make it fail. You can name it in one line.
- Existing E2E or integration coverage does not already catch that failure.
- It survives a behavior-preserving refactor.

## Delete on sight

- Tests that restate the code they were written after
- Assertion-free coverage probes (`not.toThrow()` only, render-only, `toBeDefined()` on an import)
- Source, import, or string greps over source files
- Mocks that implement the behavior being asserted
- Expected values produced by the code under test
- Tests whose only purpose is to keep a test-only export, wrapper, or seam alive (delete the seam too)
- Near-duplicates of a stronger test at a higher boundary, or table rows that hit the same branch. "Same branch" is a claim about production code: open it and check. Each `case` of a `switch` and each entry in a mapping table is its own branch (`<` is not a duplicate of `>`; one code's mapping does not cover another's).

## Before deleting a test

Read the test and its production owner. Name what it would catch and check whether a higher-boundary test already catches it. Never delete a failing test. When deleting a test leaves a production export used only by tests, remove that export in the same change.

## Periodic review

To audit an existing suite for low-signal tests, follow [references/periodic-review.md](references/periodic-review.md).
