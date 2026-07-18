import { lstat, readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessRunner } from "./process";
import { skillAgentDirectories } from "./skill-layout";

async function assertLink(path: string, target: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`tracked skill link is missing: ${path}`);
    }
    throw error;
  }
  if (!metadata.isSymbolicLink()) {
    throw new Error(`tracked skill path is not a symlink: ${path}`);
  }
  const actual = await readlink(path);
  if (actual !== target) {
    throw new Error(`tracked skill link has wrong target: ${path}`);
  }
}

export async function validateSkillLinks(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}): Promise<string> {
  const result = await options.processes.run({
    argv: [
      "git",
      "-C",
      options.checkoutRoot,
      "ls-files",
      "-z",
      "--",
      "home/.agents/skills/*/SKILL.md",
    ],
    cwd: options.checkoutRoot,
    env: options.env,
  });
  if (result.exitCode !== 0) throw new Error("failed to inspect tracked skills");

  const names = result.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => path.split("/").at(-2)!)
    .sort();
  const agentDirectories = skillAgentDirectories(options.checkoutRoot);
  for (const name of names) {
    for (const directory of agentDirectories) {
      await assertLink(join(directory.path, name), directory.target(name));
    }
  }
  for (const directory of agentDirectories) {
    const entries = await readdir(directory.path, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      const path = join(directory.path, entry.name);
      try {
        await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`tracked skill link is dangling: ${path}`);
        }
        throw error;
      }
    }
  }
  return `Skill links valid (${names.length})\n`;
}
