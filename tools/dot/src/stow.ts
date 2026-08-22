import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProcessRunner } from "./process";
import type { Terminal } from "./terminal";

const STOW_IGNORE_REGEX = "node_modules|dist|out|coverage|logs|\\.cache|build|\\.DS_Store|\\.tsbuildinfo";
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "out", "coverage", "logs", ".cache", "build"]);

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

interface FileSnapshot {
  readonly dev: number;
  readonly hash: string;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
}

type PlannedAction =
  | { readonly kind: "remove-identical"; readonly relative: string; readonly snapshot: FileSnapshot }
  | { readonly kind: "backup"; readonly relative: string; readonly snapshot: FileSnapshot }
  | { readonly kind: "keep"; readonly relative: string };

function ignored(relative: string, directory = false): boolean {
  const parts = relative.split("/");
  if (parts.some((part) => IGNORED_DIRECTORIES.has(part))) return true;
  const basename = parts.at(-1) ?? "";
  return basename === ".DS_Store" || (!directory && basename.endsWith(".tsbuildinfo"));
}

async function trackedPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignored(relative, entry.isDirectory())) continue;
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
      else if (entry.isFile() || entry.isSymbolicLink()) paths.push(relative);
    }
  }
  await visit(root, "");
  return paths.sort(compareStrings);
}

async function sameFile(source: string, target: string): Promise<boolean> {
  try {
    const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target)]);
    return sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino;
  } catch {
    return false;
  }
}

async function snapshot(path: string): Promise<FileSnapshot> {
  const [metadata, bytes] = await Promise.all([lstat(path), readFile(path)]);
  return {
    dev: metadata.dev,
    hash: createHash("sha256").update(bytes).digest("hex"),
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
  };
}

function snapshotMatches(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.hash === right.hash
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveConflict(options: {
  readonly relative: string;
  readonly source: string;
  readonly target: string;
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<"backup" | "keep"> {
  for (;;) {
    const difference = await options.processes.run({
      argv: ["diff", "-u", options.target, options.source],
      cwd: options.cwd,
      env: options.env,
    });
    if (difference.stdout) options.terminal.write(difference.stdout);
    if (difference.stderr) options.terminal.write(difference.stderr);
    const answer = (
      await options.terminal.prompt(
        `Existing live file conflicts with ~/${options.relative}. Use tracked, keep live, show diff again, or abort? [u/k/d/a]: `
      )
    ).toLowerCase();
    if (answer === "u") return "backup";
    if (answer === "k") return "keep";
    if (answer === "a" || answer === "") throw new Error("stow aborted before mutation");
    if (answer !== "d") options.terminal.write("Please choose u, k, d, or a.\n");
  }
}

export async function inspectStow(options: {
  readonly checkoutRoot: string;
  readonly home: string;
}): Promise<number> {
  const sourceRoot = join(options.checkoutRoot, "home");
  const sourceStats = await lstat(sourceRoot).catch((error: unknown) => {
    throw new Error(`tracked home package is missing at ${sourceRoot}`, { cause: error });
  });
  if (!sourceStats.isDirectory()) throw new Error(`tracked home package is missing at ${sourceRoot}`);

  let drift = 0;
  for (const relative of await trackedPaths(sourceRoot)) {
    const source = join(sourceRoot, relative);
    const target = join(options.home, relative);
    try {
      await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        drift += 1;
        continue;
      }
      throw error;
    }
    if (!(await sameFile(source, target))) drift += 1;
  }
  return drift;
}

export interface StowOptions {
  readonly acceptTracked: boolean;
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
}

export interface StowPlan {
  readonly actions: readonly PlannedAction[];
  readonly options: StowOptions;
}

/** Decides what (if anything) must happen to one tracked path before Stow can link it. */
async function planActionFor(
  options: StowOptions,
  sourceRoot: string,
  relative: string
): Promise<PlannedAction | undefined> {
  const source = join(sourceRoot, relative);
  const target = join(options.home, relative);

  let targetMetadata: Stats;
  try {
    targetMetadata = await lstat(target);
  } catch (error) {
    // Nothing live at the target, so Stow can link it without help.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (await sameFile(source, target)) return undefined;
  if (targetMetadata.isSymbolicLink() || targetMetadata.isDirectory()) return undefined;
  if (!targetMetadata.isFile()) return undefined;

  const [sourceBytes, targetBytes, targetSnapshot] = await Promise.all([
    readFile(source),
    readFile(target),
    snapshot(target),
  ]);
  if (sourceBytes.equals(targetBytes)) {
    return { kind: "remove-identical", relative, snapshot: targetSnapshot };
  }

  if (options.acceptTracked) return { kind: "backup", relative, snapshot: targetSnapshot };
  if (!options.terminal.interactive) {
    throw new Error(`~/${relative} conflicts with tracked state; rerun with --yes`);
  }

  const choice = await resolveConflict({
    cwd: options.checkoutRoot,
    env: options.env,
    processes: options.processes,
    relative,
    source,
    target,
    terminal: options.terminal,
  });
  return { kind: choice, relative, snapshot: targetSnapshot } as PlannedAction;
}

/** Guards against a live file changing between planning and applying. */
async function assertPlanStillCurrent(
  options: StowOptions,
  actions: readonly PlannedAction[]
): Promise<void> {
  for (const action of actions) {
    if (action.kind === "keep") continue;
    const current = await snapshot(join(options.home, action.relative)).catch(() => undefined);
    if (!(current && snapshotMatches(current, action.snapshot))) {
      throw new Error(`~/${action.relative} changed while stow was being planned`);
    }
  }
}

export async function planStow(options: StowOptions): Promise<StowPlan> {
  const sourceRoot = join(options.checkoutRoot, "home");
  const sourceStats = await lstat(sourceRoot).catch((error: unknown) => {
    throw new Error(`tracked home package is missing at ${sourceRoot}`, { cause: error });
  });
  if (!sourceStats.isDirectory()) throw new Error(`tracked home package is missing at ${sourceRoot}`);

  const probe = await options.processes.run({
    argv: ["stow", "--version"],
    cwd: options.checkoutRoot,
    env: options.env,
  });
  if (probe.exitCode !== 0) throw new Error("GNU Stow is required; run 'dot init'");

  const actions: PlannedAction[] = [];
  for (const relative of await trackedPaths(sourceRoot)) {
    const action = await planActionFor(options, sourceRoot, relative);
    if (action) actions.push(action);
  }

  await assertPlanStillCurrent(options, actions);
  return { actions, options };
}

export async function applyStowPlan(plan: StowPlan): Promise<string> {
  const { actions, options } = plan;
  const backups = actions.filter((action) => action.kind === "backup");
  let backupRoot: string | undefined;
  if (backups.length) {
    const parent = join(options.checkoutRoot, "backups/stow-conflicts");
    await mkdir(parent, { recursive: true });
    backupRoot = await mkdtemp(join(parent, `${new Date().toISOString().replaceAll(":", "-")}-`));
  }

  for (const action of actions) {
    const target = join(options.home, action.relative);
    if (action.kind === "keep") continue;
    const current = await snapshot(target).catch(() => undefined);
    if (!(current && snapshotMatches(current, action.snapshot))) {
      throw new Error(`~/${action.relative} changed while stow was being applied`);
    }
    if (action.kind === "remove-identical") await rm(target);
    if (action.kind === "backup") {
      const destination = join(backupRoot!, action.relative);
      await mkdir(dirname(destination), { recursive: true });
      await rename(target, destination);
    }
  }

  const dynamicIgnores = actions
    .filter((action): action is Extract<PlannedAction, { kind: "keep" }> => action.kind === "keep")
    .map((action) => `--ignore=^${escapeRegex(action.relative)}$`);
  const result = await options.processes.run({
    argv: [
      "stow",
      "-R",
      "-v",
      `--ignore=${STOW_IGNORE_REGEX}`,
      ...dynamicIgnores,
      "-d",
      options.checkoutRoot,
      "-t",
      options.home,
      "home",
    ],
    cwd: options.checkoutRoot,
    env: options.env,
  });
  if (result.exitCode !== 0) {
    const recovery = backupRoot ? `; live-file backups remain at ${backupRoot}` : "";
    throw new Error(`GNU Stow failed${recovery}`);
  }

  const summaries = ["Dotfiles stowed"];
  if (backups.length) summaries.push(`${backups.length} live file(s) backed up to ${backupRoot}`);
  const identical = actions.filter((action) => action.kind === "remove-identical").length;
  if (identical) summaries.push(`${identical} identical live file(s) replaced`);
  return `${summaries.join("\n")}\n`;
}

export async function applyStow(options: StowOptions): Promise<string> {
  return applyStowPlan(await planStow(options));
}
