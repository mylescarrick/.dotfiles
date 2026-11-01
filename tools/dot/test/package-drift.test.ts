import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPackageDrift, parseBrewCleanup } from "../src/package-drift";
import type { ProcessRunner } from "../src/process";

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

describe("package drift from Bun and Pi", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
    );
  });

  async function checkout(files: Record<string, string>, runtime?: string) {
    const root = await mkdtemp(join(tmpdir(), "dot-package-drift-"));
    temporaryDirectories.push(root);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, "checkout", path, ".."), { recursive: true });
      await writeFile(join(root, "checkout", path), content);
    }
    if (runtime !== undefined) {
      await mkdir(join(root, "home/.pi/agent"), { recursive: true });
      await writeFile(join(root, "home/.pi/agent/settings.json"), runtime);
    }
    return { checkoutRoot: join(root, "checkout"), home: join(root, "home") };
  }

  const installedBun: ProcessRunner = {
    run: (request) =>
      Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: request.argv[0] === "bun" ? "├── declared-tool@1.0.0\n└── handmade-tool@2.0.0\n" : "",
      }),
  };

  test("reports a global Bun package the manifest does not list, and a Pi package the defaults do not list", async () => {
    const { checkoutRoot, home } = await checkout(
      {
        "config/pi/settings.defaults.json": '{"packages":["npm:tracked"]}',
        "packages/bun-global": "declared-tool\n",
      },
      '{"packages":["npm:tracked","npm:handmade-ext"]}'
    );

    const items = await inspectPackageDrift({ checkoutRoot, env: {}, home, processes: installedBun });

    expect(items.map((item) => `${item.domain}:${item.name}`)).toEqual([
      "bun:handmade-tool",
      "pi:npm:handmade-ext",
    ]);
    expect(items[0]?.repoPath).toBe("packages/bun-global");
    expect(items[1]?.repoPath).toBe("config/pi/settings.defaults.json");
  });

  test("a missing manifest or settings file means nothing to compare, not drift", async () => {
    const { checkoutRoot, home } = await checkout({});

    expect(await inspectPackageDrift({ checkoutRoot, env: {}, home, processes: installedBun })).toEqual([]);
  });
});
