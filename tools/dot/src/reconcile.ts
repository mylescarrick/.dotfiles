import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readDeployRecord, stateDirectory, writeDeployRecord } from "./deploy-record";
import { inspectHome } from "./home-deploy";
import { inspectPackageDrift } from "./package-drift";
import type { ProcessRunner } from "./process";
import { type AnyDriftItem, coveredItems, renderPullRequest } from "./reconcile-pr";
import { inspectSkills } from "./skills";
import type { Terminal } from "./terminal";

/** The only paths a reconcile PR may touch. Anything else means the agent strayed. */
export const WRITE_BACK_ALLOWLIST = [
  "skills/",
  "packages/bundle",
  "packages/bun-global",
  "config/pi/settings.defaults.json",
  "home/",
] as const;

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
  const drift: AnyDriftItem[] = [
    ...plan.drift,
    ...(await inspectHome({ ...options, home })).drift,
    ...(await inspectPackageDrift({ ...options, home })),
  ];
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

async function markHandled(
  options: Omit<ReconcileOptions, "terminal">,
  items: readonly AnyDriftItem[]
): Promise<void> {
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

/**
 * Ignoring drift is its own command, never a follow-up prompt: a second yes/no right after the
 * agent's own question reads as its answer, and "yes" means the opposite. A skill comes back if
 * its content changes (the fingerprint includes the hash); a package has nothing to change.
 */
export async function ignoreDrift(
  options: Omit<ReconcileOptions, "terminal">,
  names: readonly string[] = []
): Promise<string> {
  const fresh = (await buildDriftReport(options)).items.filter(
    (item) => !item.handled && (names.length === 0 || names.includes(item.name))
  );
  if (fresh.length === 0) return "Nothing to ignore\n";
  await markHandled(options, fresh);
  const comesBack = fresh.some((item) => item.domain === "skill")
    ? "A skill is asked about again if it changes.\n"
    : "";
  return `Ignoring ${fresh.length} item(s); dot will stop asking:\n${describe(fresh)}\n${comesBack}`;
}

const IGNORE_HINT = "To stop being asked, run 'dot drift ignore [NAME]'.\n";

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

const UNDECLARED_SENTENCES = {
  brew: "installed with Homebrew, not in your Brewfile",
  bun: "installed globally with Bun, not in packages/bun-global",
  pi: "installed in Pi, not in the tracked Pi settings",
} as const;

const KIND_SENTENCES: Readonly<Record<string, string>> = {
  "added-locally": "new skill on this Mac, not in the repo",
  conflict: "skill changed on this Mac and in the repo",
  "deleted-locally": "skill deleted on this Mac, still in the repo",
  "modified-locally": "skill edited on this Mac",
  "vendored-added": "skill installed with the skills CLI, not in the repo",
  "vendored-updated": "skill updated on this Mac, repo has the old version",
};

const FILE_SENTENCES: Readonly<Record<string, string>> = {
  conflict: "dotfile changed on this Mac and in the repo",
  "deleted-locally": "dotfile deleted on this Mac, still in the repo",
  "modified-locally": "dotfile edited on this Mac",
};

function sentence(item: AnyDriftItem): string {
  if (item.domain === "file") return FILE_SENTENCES[item.kind] ?? item.kind;
  if (item.domain !== "skill") return UNDECLARED_SENTENCES[item.domain];
  return KIND_SENTENCES[item.kind] ?? item.kind;
}

/**
 * The agent's own shell is not a sandbox, so check what it could have reached: it must not
 * have moved `main`, touched the canonical checkout, or pushed the branch before dot did.
 */
async function assertAgentStayedInside(
  options: ReconcileOptions,
  where: { branch: string; canonical: string; mainBefore: string; worktree: string }
): Promise<void> {
  const mainNow = (
    await git(options, where.canonical, ["rev-parse", "refs/heads/main"], "failed to read main")
  ).trim();
  if (mainNow !== where.mainBefore) {
    throw new Error(`the agent moved main (worktree left at ${where.worktree}); nothing was pushed`);
  }
  const dirty = await git(options, where.canonical, ["status", "--porcelain"], "failed to inspect checkout");
  if (dirty.trim()) {
    throw new Error(
      `the agent changed the canonical checkout (worktree left at ${where.worktree}); nothing was pushed`
    );
  }
  const remote = await git(
    options,
    where.canonical,
    ["ls-remote", "--heads", "origin", `refs/heads/${where.branch}`],
    "failed to check the remote"
  );
  if (remote.trim()) {
    throw new Error(
      `the agent pushed ${where.branch} itself; review it before using it (worktree left at ${where.worktree})`
    );
  }
}

function describe(items: readonly AnyDriftItem[]): string {
  const width = Math.max(...items.map((item) => item.name.length));
  return items.map((item) => `  ${item.name.padEnd(width)}  ${sentence(item)}`).join("\n");
}

export async function reconcile(options: ReconcileOptions): Promise<string> {
  const home = requireHome(options.env);
  const report = await buildDriftReport(options);
  const fresh = report.items.filter((item) => !item.handled);
  if (fresh.length === 0) return "No drift to reconcile\n";
  if (!options.terminal.interactive) {
    return `${fresh.length} drift item(s); run 'dot reconcile' in a terminal:\n${describe(fresh)}\n`;
  }

  options.terminal.write(`This Mac differs from the repo:\n${describe(fresh)}\n`);
  if (!(await confirm(options.terminal, "Go through these with the agent? [Y/n]: ", true))) {
    return `Left as is; you will be asked again next time. ${IGNORE_HINT}`;
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

  const mainBefore = (
    await git(options, canonical, ["rev-parse", "refs/heads/main"], "failed to read main")
  ).trim();
  await options.processes.run({
    argv: [
      "pi",
      // Each reconcile runs in a new worktree, which Pi would otherwise ask to trust every time.
      // The checkout is this repo at origin/main, which already holds the user's own config.
      "--approve",
      "--skill",
      join(worktree, ".agents/skills/reconcile"),
      `Use the reconcile skill. The drift report is at ${reportPath}.`,
    ],
    cwd: worktree,
    // Switches on the reconcile-guard extension, which is inert in any other Pi session.
    env: { ...options.env, DOT_RECONCILE: "1" },
    output: "inherit",
  });

  await assertAgentStayedInside(options, { branch, canonical, mainBefore, worktree });
  const commits = await guardWriteBack(options, worktree);
  if (commits === 0) {
    await removeWorktree(options, canonical, worktree, branch);
    return `Nothing was added to the repo. Run 'dot reconcile' to try again. ${IGNORE_HINT}`;
  }

  await git(
    options,
    worktree,
    ["push", "--quiet", "-u", "origin", branch],
    `failed to push (left at ${worktree})`
  );
  const covered = await coveredItems(worktree, fresh);
  const subjects = (
    await git(
      options,
      worktree,
      ["log", "--reverse", "--format=%s", "origin/main..HEAD"],
      "failed to read commits"
    )
  )
    .split("\n")
    .filter(Boolean);
  const { body, title } = renderPullRequest(covered, subjects);
  const bodyPath = join(stateDirectory(options.env, home), "pr-body.md");
  await writeFile(bodyPath, body);
  const pr = await options.processes.run({
    argv: [
      "gh",
      "pr",
      "create",
      "--title",
      title,
      "--body-file",
      bodyPath,
      "--head",
      branch,
      "--base",
      "main",
    ],
    cwd: worktree,
    env: options.env,
  });
  if (pr.exitCode !== 0) throw new Error(`failed to open PR (branch ${branch} pushed): ${pr.stderr.trim()}`);
  await markHandled(options, covered);
  await removeWorktree(options, canonical, worktree, branch);
  const left = fresh.length - covered.length;
  const skipped = left > 0 ? `${left} item(s) were not included and will be asked about again.\n` : "";
  return `Opened ${pr.stdout.trim()}\n${skipped}Drift clears once it merges and 'dot' runs\n`;
}
