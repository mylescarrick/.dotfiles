import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type DeployRecord, readDeployRecord, stateDirectory, writeDeployRecord } from "./deploy-record";
import type { ProcessRunner } from "./process";
import { type Decision, decide, isLegacyLink, legacyRoots } from "./skill-drift";
import { hashFile } from "./tree-hash";

export type FileDriftKind = "conflict" | "deleted-locally" | "modified-locally";

/** A tracked file whose copy in ~ no longer matches what dot last put there. */
export interface FileDriftItem {
  readonly currentHash?: string;
  readonly domain: "file";
  readonly fingerprint: string;
  readonly homePath: string;
  readonly kind: FileDriftKind;
  readonly name: string;
  readonly repoPath: string;
}

interface HomeOptions {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly processes: ProcessRunner;
}

interface HomeItem {
  readonly current?: string;
  readonly decision: Decision;
  readonly desiredHash: string;
  /** A link into the checkout from the old stow layout; the content is right, the link must go. */
  readonly legacy: boolean;
  readonly rel: string;
  readonly source: string;
}

export interface HomePlan {
  readonly drift: readonly FileDriftItem[];
  readonly items: readonly HomeItem[];
  /** Folded links and file links into the checkout that apply has yet to replace with copies. */
  readonly pendingMigration: number;
}

async function lstatOrUndefined(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
}

async function gitList(options: HomeOptions, args: readonly string[]): Promise<string[]> {
  const result = await options.processes.run({
    argv: ["git", "-C", options.checkoutRoot, "ls-files", "-z", ...args, "--", "home"],
    cwd: options.checkoutRoot,
    env: options.env,
  });
  if (result.exitCode !== 0) throw new Error("failed to list tracked dotfiles");
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => path.slice("home/".length));
}

async function trackedFiles(options: HomeOptions): Promise<string[]> {
  const files = await gitList(options, []);
  // git can list a tracked path that was deleted from the worktree; that is not a file to deploy.
  const present = await Promise.all(
    files.map(async (rel) => (await lstatOrUndefined(join(options.checkoutRoot, "home", rel))) !== undefined)
  );
  return files.filter((_, index) => present[index]);
}

/** Top-level untracked or ignored entries (directories collapsed), such as an extension only this Mac has. */
async function untrackedEntries(options: HomeOptions): Promise<string[]> {
  return (await gitList(options, ["--others", "--directory"])).map((rel) => rel.replace(/\/$/, ""));
}

function dirMode(rel: string): number {
  return rel.split("/")[0] === ".ssh" ? 0o700 : 0o755;
}

/** Walks from ~ down to a path's parent, returning the first symlink on the way, if any. */
async function firstLinkAbove(
  home: string,
  rel: string
): Promise<{ readonly path: string; readonly rel: string } | undefined> {
  const parts = rel.split("/").slice(0, -1);
  for (let depth = 1; depth <= parts.length; depth++) {
    const path = join(home, ...parts.slice(0, depth));
    const metadata = await lstatOrUndefined(path);
    if (!metadata) return undefined;
    if (metadata.isSymbolicLink()) return { path, rel: parts.slice(0, depth).join("/") };
  }
  return undefined;
}

async function movePath(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    await rm(from, { force: true, recursive: true });
  }
}

/**
 * Replaces a folded link (a whole directory linking into the checkout) with a real directory.
 * Content with tracked files is copied; content only this Mac has (runtime state, an extension
 * nobody committed) is moved, so nothing is lost and the checkout stops holding it.
 */
async function unfold(
  link: string,
  rel: string,
  tracked: ReadonlySet<string>,
  prefixes: ReadonlySet<string>
) {
  const target = await realpath(link);
  const staged = `${link}.dot-unfold-${crypto.randomUUID()}`;
  await mkdir(staged, { mode: dirMode(rel) });
  for (const name of await readdir(target)) {
    const child = `${rel}/${name}`;
    const holdsTracked = tracked.has(child) || prefixes.has(child);
    if (holdsTracked)
      await cp(join(target, name), join(staged, name), { recursive: true, verbatimSymlinks: true });
    else await movePath(join(target, name), join(staged, name));
  }
  await rm(link);
  await rename(staged, link);
}

function trackedPrefixes(files: readonly string[]): Set<string> {
  const prefixes = new Set<string>();
  for (const rel of files) {
    const parts = rel.split("/");
    for (let depth = 1; depth < parts.length; depth++) prefixes.add(parts.slice(0, depth + 1).join("/"));
  }
  return prefixes;
}

const NEVER_WALK = new Set([".cache", ".git", "build", "coverage", "dist", "logs", "node_modules", "out"]);

/**
 * Links into the checkout for things only this Mac has (a secrets file, an extension nobody
 * committed). Git collapses an untracked folder into one entry, so walk into it, but never
 * into dependency trees: those are large and never linked from ~.
 */
async function moveUntrackedLinks(options: HomeOptions, roots: readonly string[]): Promise<number> {
  let moved = 0;
  async function visit(rel: string, depth: number): Promise<void> {
    const path = join(options.home, rel);
    const metadata = await lstatOrUndefined(path);
    if (!metadata) return;
    if (metadata.isSymbolicLink()) {
      if (!isLegacyLink(path, await readlink(path), roots)) return;
      const target = await realpath(path);
      await rm(path);
      await movePath(target, path);
      moved += 1;
    } else if (metadata.isDirectory() && depth < 8) {
      const names = await readdir(join(options.checkoutRoot, "home", rel)).catch(() => [] as string[]);
      for (const name of names) if (!NEVER_WALK.has(name)) await visit(`${rel}/${name}`, depth + 1);
    }
  }
  for (const rel of await untrackedEntries(options)) await visit(rel, 0);
  return moved;
}

/** First-run migration: no link from ~ into the checkout survives, and nothing local is lost. */
async function migrateLinks(
  options: HomeOptions,
  files: readonly string[],
  roots: readonly string[]
): Promise<number> {
  const tracked = new Set(files);
  const prefixes = trackedPrefixes(files);
  let migrated = 0;
  for (const rel of files) {
    const link = await firstLinkAbove(options.home, rel);
    if (!link) continue;
    if (!isLegacyLink(link.path, await readlink(link.path), roots)) {
      throw new Error(`~/${link.rel} is a link outside the checkout; replace it with a real directory`);
    }
    await unfold(link.path, link.rel, tracked, prefixes);
    migrated += 1;
  }
  migrated += await moveUntrackedLinks(options, roots);
  return migrated;
}

async function observe(
  path: string,
  roots: readonly string[]
): Promise<{ current?: string; legacy: boolean }> {
  const metadata = await lstatOrUndefined(path);
  if (!metadata) return { legacy: false };
  if (metadata.isSymbolicLink()) {
    const target = await readlink(path);
    if (isLegacyLink(path, target, roots)) return { current: await hashFile(path), legacy: true };
    return { current: `link:${target}`, legacy: false };
  }
  if (metadata.isFile()) return { current: await hashFile(path), legacy: false };
  return { current: "other", legacy: false };
}

export async function planHome(options: HomeOptions & { readonly record: DeployRecord }): Promise<HomePlan> {
  const roots = await legacyRoots(options.checkoutRoot);
  const files = await trackedFiles(options);
  const items: HomeItem[] = [];
  const drift: FileDriftItem[] = [];
  let pendingMigration = 0;
  for (const rel of files) {
    const source = join(options.checkoutRoot, "home", rel);
    if (!(await lstat(source)).isFile())
      throw new Error(`tracked dotfile is not a regular file: home/${rel}`);
    const desiredHash = await hashFile(source);
    const { current, legacy } = await observe(join(options.home, rel), roots);
    const folded = await firstLinkAbove(options.home, rel);
    if (legacy || folded) pendingMigration += 1;
    const decision = decide({ current, desired: desiredHash, recorded: options.record.entries[rel]?.hash });
    items.push({ current, decision, desiredHash, legacy: legacy || folded !== undefined, rel, source });
    if (decision.action === "drift") {
      drift.push({
        currentHash: current,
        domain: "file",
        fingerprint: `${decision.kind}:file:${rel}:${current ?? "absent"}`,
        homePath: join(options.home, rel),
        kind: decision.kind as FileDriftKind,
        name: rel,
        repoPath: `home/${rel}`,
      });
    }
  }
  // A file the repo dropped but this Mac still has, untouched, is removed; otherwise it is simply forgotten.
  for (const [rel, entry] of Object.entries(options.record.entries)) {
    if (files.includes(rel) || rel.startsWith(".agents/skills/")) continue;
    const { current } = await observe(join(options.home, rel), roots);
    const decision = decide({ current, recorded: entry.hash });
    items.push({ current, decision, desiredHash: "", legacy: false, rel, source: "" });
    if (decision.action === "drift") {
      drift.push({
        currentHash: current,
        domain: "file",
        fingerprint: `conflict:file:${rel}:${current ?? "absent"}`,
        homePath: join(options.home, rel),
        kind: "conflict",
        name: rel,
        repoPath: `home/${rel}`,
      });
    }
  }
  return { drift, items, pendingMigration };
}

async function copyIntoPlace(source: string, target: string, rel: string): Promise<void> {
  await mkdir(dirname(target), { mode: dirMode(rel), recursive: true });
  const staged = join(dirname(target), `.${basename(target)}.dot-${crypto.randomUUID()}`);
  await copyFile(source, staged);
  await chmod(staged, ((await stat(source)).mode & 0o111) === 0 ? 0o644 : 0o755);
  // rename replaces a link itself, not what it points at.
  await rename(staged, target);
}

async function backup(options: HomeOptions, rel: string, stamp: string): Promise<string | undefined> {
  const path = join(options.home, rel);
  if (!(await lstatOrUndefined(path))) return undefined;
  const destination = join(stateDirectory(options.env, options.home), "backups", stamp, rel);
  await mkdir(dirname(destination), { recursive: true });
  await cp(path, destination, { recursive: true, verbatimSymlinks: true });
  return destination;
}

interface DeployState {
  readonly counts: {
    backedUp: number;
    installed: number;
    linksReplaced: number;
    removed: number;
    updated: number;
  };
  readonly record: DeployRecord;
  readonly roots: readonly string[];
  readonly settled: Set<string>;
  readonly stamp: string;
}

/** Whether this plan item writes a file: new, repo-changed, a link to replace, or drift the user accepted. */
function writes(item: HomeItem, acceptTracked: boolean): "accepted" | "plain" | undefined {
  const action = item.decision.action;
  if (action === "drift") return acceptTracked && item.desiredHash !== "" ? "accepted" : undefined;
  if (action === "install" || action === "update" || (action === "in-sync" && item.legacy)) return "plain";
  return undefined;
}

async function deployItem(
  item: HomeItem,
  options: HomeOptions & { readonly acceptTracked: boolean },
  state: DeployState
): Promise<void> {
  const target = join(options.home, item.rel);
  const action = item.decision.action;
  const kind = writes(item, options.acceptTracked);
  if (kind) {
    // A tool may have written the file since planning; never overwrite what was not seen.
    const now = await observe(target, state.roots);
    if (now.current !== item.current)
      throw new Error(`~/${item.rel} changed while dotfiles were being applied`);
    if (kind === "accepted" && (await backup(options, item.rel, state.stamp))) state.counts.backedUp += 1;
    await copyIntoPlace(item.source, target, item.rel);
    state.record.entries[item.rel] = { hash: item.desiredHash };
    if (kind === "accepted") state.settled.add(item.rel);
    if (action === "install") state.counts.installed += 1;
    else if (action === "in-sync") state.counts.linksReplaced += 1;
    else state.counts.updated += 1;
  } else if (action === "in-sync") {
    state.record.entries[item.rel] = { hash: item.desiredHash };
  } else if (action === "remove") {
    await rm(target, { force: true });
    delete state.record.entries[item.rel];
    state.counts.removed += 1;
  } else if (action === "forget") {
    delete state.record.entries[item.rel];
  }
}

export async function deployHome(
  options: HomeOptions & { readonly acceptTracked: boolean; readonly now?: Date }
): Promise<string> {
  const roots = await legacyRoots(options.checkoutRoot);
  const migrated = await migrateLinks(options, await trackedFiles(options), roots);
  const record = await readDeployRecord(options.env, options.home);
  const plan = await planHome({ ...options, record });
  const state: DeployState = {
    counts: { backedUp: 0, installed: 0, linksReplaced: migrated, removed: 0, updated: 0 },
    record,
    roots,
    settled: new Set(),
    stamp: (options.now ?? new Date()).toISOString().replaceAll(":", "-"),
  };
  for (const item of plan.items) await deployItem(item, options, state);
  await writeDeployRecord(options.env, options.home, record);

  const { counts } = state;
  const left = plan.drift.filter((entry) => !state.settled.has(entry.name)).length;
  const lines = [
    `Dotfiles deployed (${counts.installed} installed, ${counts.updated} updated, ${counts.linksReplaced} link(s) replaced, ${counts.removed} removed)`,
  ];
  if (counts.backedUp) {
    const where = join(stateDirectory(options.env, options.home), "backups", state.stamp);
    lines.push(`${counts.backedUp} file(s) backed up to ${where}`);
  }
  if (left > 0) lines.push(`${left} file(s) differ from the repo and were kept; run 'dot reconcile'`);
  return `${lines.join("\n")}\n`;
}

/** Read-only: what is out of date and what differs, without touching anything. */
export async function inspectHome(options: HomeOptions): Promise<HomePlan> {
  return planHome({ ...options, record: await readDeployRecord(options.env, options.home) });
}

/** Discards drift for one file by redeploying the repo version, keeping a backup of what was there. */
export async function restoreFile(
  options: HomeOptions & { readonly name: string; readonly now?: Date }
): Promise<string> {
  const roots = await legacyRoots(options.checkoutRoot);
  const record = await readDeployRecord(options.env, options.home);
  const plan = await planHome({ ...options, record });
  const item = plan.items.find((candidate) => candidate.rel === options.name && candidate.desiredHash !== "");
  if (!item) throw new Error(`no repo version of ${options.name} to restore`);
  const stamp = (options.now ?? new Date()).toISOString().replaceAll(":", "-");
  const saved = await backup(options, item.rel, stamp);
  const now = await observe(join(options.home, item.rel), roots);
  if (now.current !== item.current) throw new Error(`~/${item.rel} changed while it was being restored`);
  await copyIntoPlace(item.source, join(options.home, item.rel), item.rel);
  record.entries[item.rel] = { hash: item.desiredHash };
  await writeDeployRecord(options.env, options.home, record);
  return `Restored ~/${item.rel} from the repo${saved ? ` (previous copy kept at ${saved})` : ""}\n`;
}
