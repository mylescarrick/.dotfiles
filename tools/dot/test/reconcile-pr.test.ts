import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileDriftItem } from "../src/home-deploy";
import type { PackageDriftItem } from "../src/package-drift";
import { coveredItems, renderPullRequest } from "../src/reconcile-pr";
import { hashFile } from "../src/tree-hash";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function branch(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dot-pr-"));
  temporaryDirectories.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function item(
  domain: PackageDriftItem["domain"],
  name: string,
  pkg: PackageDriftItem["package"],
  repoPath: PackageDriftItem["repoPath"]
): PackageDriftItem {
  return {
    domain,
    fingerprint: `installed-undeclared:${domain}:${name}`,
    kind: "installed-undeclared",
    name,
    package: pkg,
    repoPath,
  };
}

describe("which package items a branch settles", () => {
  test("recognises a Bun package by name, with or without a pinned version, and a Pi package by source", async () => {
    const worktree = await branch({
      "config/pi/settings.defaults.json": '{"packages":["npm:tracked","npm:added-ext"]}',
      "packages/bun-global": "# globals\nadded-tool\npinned-tool@1.2.3\n",
      "packages/bundle": 'brew "typst"\n',
    });
    const bun = (name: string) => item("bun", name, "global", "packages/bun-global");

    const covered = await coveredItems(worktree, [
      bun("added-tool"),
      bun("pinned-tool"),
      bun("added"),
      bun("missing-tool"),
      item("pi", "npm:added-ext", "extension", "config/pi/settings.defaults.json"),
      item("pi", "npm:other-ext", "extension", "config/pi/settings.defaults.json"),
      item("brew", "typst", "formula", "packages/bundle"),
    ]);

    expect(covered.map((entry) => entry.name)).toEqual([
      "added-tool",
      "pinned-tool",
      "npm:added-ext",
      "typst",
    ]);
  });

  test("the PR says, in plain words, where each package was declared", () => {
    const { body } = renderPullRequest(
      [
        item("bun", "handmade-tool", "global", "packages/bun-global"),
        item("pi", "npm:handmade-ext", "extension", "config/pi/settings.defaults.json"),
      ],
      ["chore(packages): declare tools"]
    );

    expect(body).toContain("- **Declare `handmade-tool` as a global Bun package.**");
    expect(body).toContain("- **Declare the Pi package `npm:handmade-ext`.**");
    expect(body).toContain("`config/pi/settings.defaults.json`");
  });
});

describe("which dotfile items a branch settles", () => {
  test("a file is settled when the repo copy now matches this Mac's, or is gone for a deletion", async () => {
    const worktree = await branch({ "home/.zshrc": "export A=mine\n" });
    const hash = await hashFile(join(worktree, "home/.zshrc"));
    const file = (name: string, kind: FileDriftItem["kind"], currentHash?: string): FileDriftItem => ({
      currentHash,
      domain: "file",
      fingerprint: `${kind}:file:${name}`,
      homePath: `/home/${name}`,
      kind,
      name,
      repoPath: `home/${name}`,
    });

    const covered = await coveredItems(worktree, [
      file(".zshrc", "modified-locally", hash),
      file(".zprofile", "modified-locally", hash),
      file(".config/gone", "deleted-locally"),
      file(".zshrc", "deleted-locally"),
    ]);

    expect(covered.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      "modified-locally:.zshrc",
      "deleted-locally:.config/gone",
    ]);
  });

  test("the PR names the file and where it landed", () => {
    const { body } = renderPullRequest(
      [
        {
          currentHash: "x",
          domain: "file",
          fingerprint: "f",
          homePath: "/h/.zshrc",
          kind: "modified-locally",
          name: ".zshrc",
          repoPath: "home/.zshrc",
        },
      ],
      ["chore(home): take zshrc edits"]
    );

    expect(body).toContain("- **Take this Mac's version of `~/.zshrc`.**");
    expect(body).toContain("`home/.zshrc`");
  });
});
