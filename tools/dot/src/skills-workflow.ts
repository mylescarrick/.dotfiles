import { realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProcessRunner } from "./process";
import { runSkillsCli } from "./skills-authoring";
import type { Terminal } from "./terminal";

const SKILL_PATHS = [
  "home/.agents/skills",
  "home/.agents/.skill-lock.json",
  "home/.pi/agent/skills",
  "home/.claude/skills",
] as const;

async function isCanonicalMainCheckout(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}): Promise<boolean> {
  const home = options.env.HOME;
  if (!home) return false;

  const [checkoutRoot, canonicalRoot] = await Promise.all([
    realpath(options.checkoutRoot),
    realpath(join(home, ".dotfiles")).catch(() => undefined),
  ]);
  if (!canonicalRoot || checkoutRoot !== canonicalRoot) return false;

  const branch = await options.processes.run({
    argv: ["git", "-C", checkoutRoot, "branch", "--show-current"],
    cwd: checkoutRoot,
    env: options.env,
  });
  return branch.stdout.trim() === "main";
}

function timestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:.]/g, "")
    .replace("T", "-")
    .slice(0, 15);
}

function commitSubjectFor(action: "add" | "update" | "remove", args: readonly string[]): string {
  if (action === "update") return "chore(skills): update vendored skills";
  if (action === "add") return `chore(skills): add ${args.slice(1).join(", ")}`;
  return `chore(skills): remove ${args.join(", ")}`;
}

function prBodyFor(action: "add" | "update" | "remove", args: readonly string[]): string {
  const detail =
    action === "update"
      ? "Refreshed vendored skills from their upstream sources."
      : action === "add"
        ? `Vendored ${args.slice(1).join(", ")} from ${args[0]}.`
        : `Removed vendored skill(s): ${args.join(", ")}.`;
  return `Automated via \`dot skills ${action}\`.\n\n## Summary\n- ${detail}\n\n## Test plan\n- [ ] Review the diff for unexpected upstream changes\n`;
}

async function runInWorktree(options: {
  readonly action: "add" | "update" | "remove";
  readonly args: readonly string[];
  readonly canonicalRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
  readonly now: Date;
}): Promise<string> {
  const { action, args, canonicalRoot, env, processes, now } = options;
  const branch = `chore/skills-${action}-${timestamp(now)}`;
  const worktreePath = join(dirname(canonicalRoot), ".dotfiles-worktrees", branch.replace("chore/", ""));

  const add = await processes.run({
    argv: ["git", "-C", canonicalRoot, "worktree", "add", "-b", branch, worktreePath, "main"],
    cwd: canonicalRoot,
    env,
  });
  if (add.exitCode !== 0) throw new Error(`failed to create worktree: ${add.stderr}`);

  const output = await runSkillsCli({ action, args, checkoutRoot: worktreePath, env, processes });

  const status = await processes.run({
    argv: ["git", "-C", worktreePath, "status", "--porcelain", "--", ...SKILL_PATHS],
    cwd: worktreePath,
    env,
  });
  if (!status.stdout.trim()) {
    await processes.run({
      argv: ["git", "-C", canonicalRoot, "worktree", "remove", worktreePath],
      cwd: canonicalRoot,
      env,
    });
    await processes.run({
      argv: ["git", "-C", canonicalRoot, "branch", "-D", branch],
      cwd: canonicalRoot,
      env,
    });
    return `${output}Nothing to commit; removed worktree\n`;
  }

  const existingPaths: string[] = [];
  for (const path of SKILL_PATHS) {
    const present = await stat(join(worktreePath, path)).then(
      () => true,
      () => false,
    );
    if (present) existingPaths.push(path);
  }
  const stage = await processes.run({
    argv: ["git", "-C", worktreePath, "add", "--", ...existingPaths],
    cwd: worktreePath,
    env,
  });
  if (stage.exitCode !== 0) throw new Error(`failed to stage skill changes: ${stage.stderr}`);

  const subject = commitSubjectFor(action, args);
  const commit = await processes.run({
    argv: ["git", "-C", worktreePath, "commit", "-m", subject],
    cwd: worktreePath,
    env,
  });
  if (commit.exitCode !== 0) throw new Error(`failed to commit skill changes: ${commit.stderr}`);

  const push = await processes.run({
    argv: ["git", "-C", worktreePath, "push", "-u", "origin", branch],
    cwd: worktreePath,
    env,
  });
  if (push.exitCode !== 0) {
    throw new Error(`failed to push branch (worktree left at ${worktreePath}): ${push.stderr}`);
  }

  const pr = await processes.run({
    argv: [
      "gh",
      "pr",
      "create",
      "--title",
      subject,
      "--body",
      prBodyFor(action, args),
      "--head",
      branch,
      "--base",
      "main",
    ],
    cwd: worktreePath,
    env,
  });
  if (pr.exitCode !== 0) {
    throw new Error(`failed to open PR (worktree left at ${worktreePath}): ${pr.stderr}`);
  }

  return `${output}${subject}\nWorktree: ${worktreePath}\n${pr.stdout.trim()}\n`;
}

export async function runSkillsMutation(options: {
  readonly action: "add" | "update" | "remove";
  readonly args: readonly string[];
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
  readonly acceptAll: boolean;
  readonly now?: Date;
}): Promise<string> {
  if (!(await isCanonicalMainCheckout(options))) {
    return runSkillsCli(options);
  }

  if (!options.acceptAll) {
    if (!options.terminal.interactive) {
      throw new Error(
        `dot skills ${options.action} must not run directly against the canonical checkout on main; ` +
          "rerun with --yes to create a worktree and open a PR automatically, or run it inside a worktree",
      );
    }
    const answer = (
      await options.terminal.prompt(
        `dot skills ${options.action} would modify the canonical checkout on main directly.\n` +
          "Create a worktree, run it there, and open a PR instead? [Y/n]: ",
      )
    )
      .trim()
      .toLowerCase();
    if (answer === "n" || answer === "no") {
      throw new Error(
        `aborted: create a worktree (e.g. 'wt chore/skills-${options.action}') and rerun ` +
          `dot skills ${options.action} inside it`,
      );
    }
  }

  const canonicalRoot = await realpath(options.checkoutRoot);
  return runInWorktree({
    action: options.action,
    args: options.args,
    canonicalRoot,
    env: options.env,
    processes: options.processes,
    now: options.now ?? new Date(),
  });
}
