import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { truncateTextOutput } from "../truncation.ts";

test("truncateTextOutput writes the full output to a temp file when truncated", async () => {
  const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  const truncated = await truncateTextOutput(output, {
    fileName: "output.txt",
    maxBytes: 10_000,
    maxLines: 5,
    tempPrefix: "pi-web-tools-test-",
  });

  assert.equal(truncated.truncated, true);
  assert.ok(truncated.fullOutputPath);
  assert.match(truncated.text, /Output truncated:/);
  const saved = await readFile(truncated.fullOutputPath!, "utf8");
  assert.equal(saved, output);
});
