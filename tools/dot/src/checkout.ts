import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessRunner } from "./process";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function git(
  processes: ProcessRunner,
  checkoutRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  args: readonly string[],
): Promise<string> {
  const result = await processes.run({
    argv: ["git", "-C", checkoutRoot, ...args],
    cwd: checkoutRoot,
    env,
  });
  if (result.exitCode !== 0) {
    throw new Error("failed to inspect canonical checkout");
  }
  return result.stdout.trim();
}

export async function guardCanonicalCheckout(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}): Promise<void> {
  const home = options.env.HOME;
  if (!home) throw new Error("HOME is required");

  const [checkoutRoot, canonicalRoot] = await Promise.all([
    realpath(options.checkoutRoot),
    realpath(join(home, ".dotfiles")).catch(() => undefined),
  ]);
  if (!canonicalRoot || checkoutRoot !== canonicalRoot) {
    throw new Error(
      `machine mutation must run from the canonical checkout at ${join(home, ".dotfiles")}`,
    );
  }

  const gitDir = await git(options.processes, checkoutRoot, options.env, [
    "rev-parse",
    "--absolute-git-dir",
  ]);
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ]) {
    if (await exists(join(gitDir, marker))) {
      throw new Error("canonical checkout has an unfinished Git operation");
    }
  }

  const branch = await git(options.processes, checkoutRoot, options.env, [
    "branch",
    "--show-current",
  ]);
  if (branch !== "main") {
    throw new Error(
      `canonical checkout must be on main (found '${branch || "detached HEAD"}')`,
    );
  }

  const status = await git(options.processes, checkoutRoot, options.env, [
    "status",
    "--porcelain",
  ]);
  if (status) throw new Error("canonical checkout has uncommitted changes");

  const head = await git(options.processes, checkoutRoot, options.env, [
    "rev-parse",
    "HEAD",
  ]);
  const remote = await git(options.processes, checkoutRoot, options.env, [
    "rev-parse",
    "--verify",
    "refs/remotes/origin/main",
  ]).catch(() => {
    throw new Error("origin/main is unavailable; run 'dot update'");
  });

  if (head === remote) return;

  const headIsAncestor = await options.processes.run({
    argv: ["git", "-C", checkoutRoot, "merge-base", "--is-ancestor", head, remote],
    cwd: checkoutRoot,
    env: options.env,
  });
  if (headIsAncestor.exitCode === 0) {
    throw new Error("canonical checkout is behind origin/main; run 'dot update'");
  }
  throw new Error("canonical main is ahead of or diverged from origin/main");
}
