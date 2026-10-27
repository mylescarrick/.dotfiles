import { describe, expect, test } from "bun:test";
import { parseBrewCleanup } from "../src/brew-drift";

describe("brew cleanup parsing", () => {
  test("reads formulae, casks and taps but not cache cleanup", () => {
    const items = parseBrewCleanup(
      [
        "Would uninstall formulae:",
        "typst ripgrep",
        "Would uninstall casks:",
        "zoom",
        "Would untap:",
        "foo/bar",
        "Would `brew cleanup`:",
        "Would remove: /Users/x/Library/Caches/Homebrew/lz4--1.10.0 (279.7KB)",
        "Run `brew bundle cleanup --force` to make these changes.",
      ].join("\n")
    );

    expect(items.map((item) => `${item.package}:${item.name}`)).toEqual([
      "formula:typst",
      "formula:ripgrep",
      "cask:zoom",
      "tap:foo/bar",
    ]);
    expect(items[0]?.fingerprint).toBe("installed-undeclared:formula:typst");
  });

  test("reports nothing when there is nothing to clean", () => {
    expect(parseBrewCleanup("")).toEqual([]);
  });
});
