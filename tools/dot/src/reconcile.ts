import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type BrewDriftItem, inspectBrewDrift } from "./brew-drift";
import { readDeployRecord, stateDirectory, writeDeployRecord } from "./deploy-record";
import type { ProcessRunner } from "./process";
import type { DriftItem } from "./skill-drift";
import { inspectSkills } from "./skills";
import type { Terminal } from "./terminal";

/** The only paths a reconcile PR may touch. Anything else means the agent strayed. */
export const WRITE_BACK_ALLOWLIST = ["skills/", "packages/bundle"] as const;

type AnyDriftItem = BrewDriftItem | DriftItem;

interface ReconcileOptions {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: Date;
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
}

export interface DriftReport {
  readonly checkout: string;
  readonly generatedAt: string;
  readonly items: readonly (AnyDriftItem & { readonly handled: boolean })[];
  readonly writeBackAllowlist: readonly string[];
}

function requireHome(env: Readonly<Record<string, string | undefined>>): string {
  if (!env.HOME) throw new Error("HOME is required");
  return env.HOME;
}

export async function buildDriftReport(options: Omit<ReconcileOptions, "terminal">): Promise<DriftReport> {
  const home = requireHome(options.env);
  const { plan } = await inspectSkills({ ...options, home, network: true });
  const record = await readDeployRecord(options.env, home);
  const drift: AnyDriftItem[] = [...plan.drift, ...(await inspectBrewDrift(options))];
  return {
    checkout: options.checkoutRoot,
    generatedAt: (options.now ?? new Date()).toISOString(),
    items: drift.map((item) => ({ ...item, handled: Boolean(record.handled[item.fingerprint]) })),
    writeBackAllowlist: WRITE_BACK_ALLOWLIST,
  };
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15);
}

async function markHandled(options: ReconcileOptions, items: readonly AnyDriftItem[]): Promise<void> {
  const home = requireHome(options.env);
  const record = await readDeployRecord(options.env, home);
  const at = (options.now ?? new Date()).toISOString();
  for (const item of items) record.handled[item.fingerprint] = at;
  await writeDeployRecord(options.env, home, record);
}

async function confirm(terminal: Terminal, message: string, fallback: boolean): Promise<boolean> {
  const answer = (await terminal.prompt(message)).trim().toLowerCase();
  if (answer === "") return fallback;
  return answer === "y" || answer === "yes";
}

async function offerSnooze(options: ReconcileOptions, items: readonly AnyDriftItem[]): Promise<string> {
  if (await confirm(options.terminal, "Snooze these drift items until they change again? [y/N]: ", false)) {
    await markHandled(options, items);
    return `Snoozed ${items.length} drift item(s)\n`;
  }
  return "Drift left in place\n";
}

async function git(options: ReconcileOptions, cwd: string, argv: readonly string[], failure: string) {
  const result = await options.processes.run({ argv: ["git", "-C", cwd, ...argv], cwd, env: options.env });
  if (result.exitCode !== 0) throw new Error(`${failure}: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Secret scan when gitleaks is installed; a missing binary is not a failure. */
async function scanForSecrets(options: ReconcileOptions, worktree: string): Promise<void> {
  let result: Awaited<ReturnType<ProcessRunner["run"]>>;
  try {
    result = await options.processes.run({
      argv: ["gitleaks", "git", "--no-banner", "--log-opts=origin/main..HEAD", worktree],
      cwd: worktree,
      env: options.env,
    });
  } catch {
    return;
  }
  if (result.exitCode !== 0) throw new Error(`gitleaks flagged the reconcile commits:\n${result.stdout}`);
}

/** A trailing slash allows a whole directory; anything else allows exactly that file. */
function allowed(entry: string, path: string): boolean {
  return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

/**
 * Checks the agent's work mechanically before anything leaves the machine. The agent is
 * told the same rules, but this is the part that does not depend on it listening.
 */
export async function guardWriteBack(options: ReconcileOptions, worktree: string): Promise<number> {
  const status = await git(options, worktree, ["status", "--porcelain"], "failed to inspect worktree");
  if (status.trim()) throw new Error(`reconcile worktree has uncommitted changes (left at ${worktree})`);
  const count = Number(
    (
      await git(options, worktree, ["rev-list", "--count", "origin/main..HEAD"], "failed to count commits")
    ).trim()
  );
  if (count === 0) return 0;
  const changed = (
    await git(options, worktree, ["diff", "--name-only", "origin/main...HEAD"], "failed to list changes")
  )
    .split("\n")
    .filter(Boolean);
  const strays = changed.filter((path) => !WRITE_BACK_ALLOWLIST.some((entry) => allowed(entry, path)));
  if (strays.length) {
    throw new Error(
      `reconcile commits touch paths outside ${WRITE_BACK_ALLOWLIST.join(", ")} (left at ${worktree}):\n${strays.join("\n")}`
    );
  }
  await scanForSecrets(options, worktree);
  return count;
}

async function removeWorktree(
  options: ReconcileOptions,
  canonical: string,
  worktree: string,
  branch: string
) {
  await git(options, canonical, ["worktree", "remove", "--force", worktree], "failed to remove worktree");
  await git(options, canonical, ["branch", "-D", branch], "failed to delete branch");
}

function describe(items: readonly AnyDriftItem[]): string {
  return items.map((item) => `  ${item.kind.padEnd(17)}${item.name}`).join("\n");
}

export async function reconcile(options: ReconcileOptions): Promise<string> {
  const home = requireHome(options.env);
  const report = await buildDriftReport(options);
  const fresh = report.items.filter((item) => !item.handled);
  if (fresh.length === 0) return "No drift to reconcile\n";
  if (!options.terminal.interactive) {
    return `${fresh.length} drift item(s); run 'dot reconcile' in a terminal:\n${describe(fresh)}\n`;
  }

  options.terminal.write(`Drift found:\n${describe(fresh)}\n`);
  if (!(await confirm(options.terminal, "Start the reconcile agent in a worktree? [Y/n]: ", true))) {
    return offerSnooze(options, fresh);
  }

  const canonical = await realpath(options.checkoutRoot);
  const now = options.now ?? new Date();
  const branch = `reconcile/${timestamp(now)}`;
  const worktree = join(dirname(canonical), ".dotfiles-worktrees", `reconcile-${timestamp(now)}`);
  await git(options, canonical, ["fetch", "--quiet", "origin", "main"], "failed to fetch origin/main");
  await git(
    options,
    canonical,
    ["worktree", "add", "-b", branch, worktree, "origin/main"],
    "failed to create worktree"
  );

  const reportPath = join(stateDirectory(options.env, home), "drift-report.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ ...report, items: fresh, worktree }, null, 2)}\n`);

  await options.processes.run({
    argv: [
      "pi",
      "--skill",
      join(worktree, ".agents/skills/reconcile"),
      `Use the reconcile skill. The drift report is at ${reportPath}.`,
    ],
    cwd: worktree,
    env: options.env,
    output: "inherit",
  });

  const commits = await guardWriteBack(options, worktree);
  if (commits === 0) {
    await removeWorktree(options, canonical, worktree, branch);
    return `Agent made no commits\n${await offerSnooze(options, fresh)}`;
  }

  await git(
    options,
    worktree,
    ["push", "--quiet", "-u", "origin", branch],
    `failed to push (left at ${worktree})`
  );
  const pr = await options.processes.run({
    argv: ["gh", "pr", "create", "--fill", "--head", branch, "--base", "main"],
    cwd: worktree,
    env: options.env,
  });
  if (pr.exitCode !== 0) throw new Error(`failed to open PR (branch ${branch} pushed): ${pr.stderr.trim()}`);
  await markHandled(options, fresh);
  await removeWorktree(options, canonical, worktree, branch);
  return `Opened ${pr.stdout.trim()}\nDrift clears once it merges and 'dot update' runs\n`;
}
