import { strict as assert } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadStyleFile, stripFrontmatter } from "../style.ts";

describe("stripFrontmatter", () => {
  it("removes YAML frontmatter and the body-start marker", () => {
    const raw = `---
name: Attention-kind
description: A test style
keep-coding-instructions: true
---

<!-- body-start -->
You are talking to a human.

## Rules

- Keep it short.
`;

    const result = stripFrontmatter(raw);

    assert.equal(result.startsWith("You are talking to a human."), true);
    assert.equal(result.includes("name: Attention-kind"), false);
    assert.equal(result.includes("<!-- body-start -->"), false);
  });

  it("returns plain text unchanged when there is no frontmatter", () => {
    const raw = "Just a body.\nNo frontmatter.";
    assert.equal(stripFrontmatter(raw), raw);
  });

  it("handles Windows line endings", () => {
    const raw = "---\r\nname: Test\r\n---\r\n\r\nBody starts here.";
    const result = stripFrontmatter(raw);
    assert.equal(result, "Body starts here.");
  });
});

describe("loadStyleFile", () => {
  it("reads a real style file and strips its frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "output-style-test-"));
    const filePath = join(dir, "style.md");

    writeFileSync(filePath, "---\nname: Fancy\n---\n\n<!-- body-start -->\nThe core style.\n");

    try {
      const result = loadStyleFile(filePath);
      assert.equal(result, "The core style.");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
