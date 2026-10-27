import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { replaceFileAtomic } from "./atomic-file";
import { type DeployRecord, readDeployRecord, writeDeployRecord } from "./deploy-record";
import type { ProcessRunner } from "./process";
import {
  GLOBAL_LOCK,
  isLegacyLink,
  legacyRoots,
  planSkills,
  SKILLS_HOME,
  type SkillPlan,
  type SkillPlanItem,
} from "./skill-drift";
import { type DesiredSkills, LOCK_FIELDS, type LockEntry, loadDesiredSkills } from "./skill-sources";
import { hashDirectory } from "./tree-hash";

/** Agent skill directories that get relative links back to ~/.agents/skills, as the skills CLI does. */
const AGENT_LINK_DIRECTORIES = [
  { path: ".pi/agent/skills", prefix: "../../../.agents/skills" },
  { path: ".claude/skills", prefix: "../../.agents/skills" },
] as const;

interface SkillsOptions {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly processes: ProcessRunner;
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Copies beside the target, then swaps, so an interrupted run never leaves half a skill. */
async function replaceDirectory(source: string, target: string): Promise<void> {
  const parent = join(target, "..");
  await mkdir(parent, { recursive: true });
  const id = crypto.randomUUID();
  const staged = join(parent, `.dot-new-${id}`);
  const retired = join(parent, `.dot-old-${id}`);
  await cp(source, staged, { recursive: true, verbatimSymlinks: true });
  const existing = await lstatOrUndefined(target);
  if (existing) await rename(target, retired);
  await rename(staged, target);
  await rm(retired, { force: true, recursive: true });
}

async function ensureLink(path: string, target: string, roots: readonly string[]): Promise<boolean> {
  const metadata = await lstatOrUndefined(path);
  if (metadata) {
    if (!metadata.isSymbolicLink()) return false;
    const actual = await readlink(path);
    if (actual === target) return false;
    // Only replace links dot owns: old stow links into the checkout, or our own prefix.
    if (
      !(isLegacyLink(path, actual, roots) || actual.endsWith(`/.agents/skills/${path.split("/").at(-1)}`))
    ) {
      return false;
    }
    await rm(path);
  }
  await mkdir(join(path, ".."), { recursive: true });
  await symlink(target, path);
  return true;
}

async function removeOwnedLink(path: string, prefix: string, roots: readonly string[]): Promise<void> {
  const metadata = await lstatOrUndefined(path);
  if (!metadata?.isSymbolicLink()) return;
  const actual = await readlink(path);
  if (actual.startsWith(`${prefix}/`) || isLegacyLink(path, actual, roots)) await rm(path);
}

/** Merges vendored entries into the skills CLI's global lock so `skills update -g` keeps working. */
async function writeGlobalLock(
  home: string,
  roots: readonly string[],
  changes: ReadonlyMap<string, LockEntry | undefined>
): Promise<void> {
  if (changes.size === 0) return;
  const path = join(home, GLOBAL_LOCK);
  const metadata = await lstatOrUndefined(path);
  let lock: { skills?: Record<string, Record<string, unknown>>; version?: number } = {};
  if (metadata?.isFile()) lock = JSON.parse(await readFile(path, "utf8"));
  else if (metadata?.isSymbolicLink() && isLegacyLink(path, await readlink(path), roots)) await rm(path);
  else if (metadata) throw new Error(`~/${GLOBAL_LOCK} is not a regular file`);

  const skills = { ...lock.skills };
  const now = new Date().toISOString();
  for (const [name, entry] of changes) {
    if (!entry) {
      delete skills[name];
      continue;
    }
    const previous = skills[name];
    if (previous?.skillFolderHash === entry.skillFolderHash) continue;
    skills[name] = { ...previous, ...entry, installedAt: previous?.installedAt ?? now, updatedAt: now };
  }
  await mkdir(join(home, ".agents"), { recursive: true });
  await replaceFileAtomic(path, `${JSON.stringify({ version: 3, ...lock, skills }, null, 2)}\n`);
}

function stableLock(entry: LockEntry): LockEntry {
  return Object.fromEntries(LOCK_FIELDS.map((field) => [field, entry[field]])) as unknown as LockEntry;
}

async function deploy(item: SkillPlanItem, options: SkillsOptions, record: DeployRecord): Promise<void> {
  const target = join(options.home, SKILLS_HOME, item.name);
  // Re-check right before writing: a tool may have changed the skill since planning.
  const now = await lstatOrUndefined(target);
  if (now?.isDirectory() && (await hashDirectory(target)) !== item.currentHash) {
    throw new Error(`~/${SKILLS_HOME}/${item.name} changed while skills were being applied`);
  }
  await replaceDirectory(item.desired!.directory!, target);
  record.entries[item.recordKey] = { hash: item.desiredHash! };
}

/**
 * Stow folds a directory into one link when nothing else lives there, so ~/.claude can be
 * the checkout itself. Writing through that would recreate the dirty-main problem.
 */
async function assertOutsideCheckout(
  options: Pick<SkillsOptions, "checkoutRoot" | "home">,
  relative: string
): Promise<void> {
  const checkout = await realpath(options.checkoutRoot);
  let probe = join(options.home, relative);
  while (!(await lstatOrUndefined(probe))) probe = join(probe, "..");
  const real = await realpath(probe);
  if (real === checkout || real.startsWith(`${checkout}/`)) {
    throw new Error(`~/${relative} resolves into the checkout; unstow it before deploying skills`);
  }
}

/**
 * Creates the deploy directories as real directories. Run before Stow: on a fresh machine
 * ~/.pi does not exist yet, and Stow would otherwise fold it into one link to the checkout.
 */
export async function prepareSkillDirectories(
  options: Pick<SkillsOptions, "checkoutRoot" | "home">
): Promise<void> {
  for (const relative of [SKILLS_HOME, ...AGENT_LINK_DIRECTORIES.map((directory) => directory.path)]) {
    await assertOutsideCheckout(options, relative);
    await mkdir(join(options.home, relative), { recursive: true });
  }
}

interface ExecutionState {
  readonly counts: { installed: number; removed: number; updated: number };
  readonly lockChanges: Map<string, LockEntry | undefined>;
  readonly record: DeployRecord;
  readonly roots: readonly string[];
}

async function executeItem(
  item: SkillPlanItem,
  plan: SkillPlan,
  options: SkillsOptions,
  state: ExecutionState
) {
  const action = item.decision.action;
  if (action === "install" || action === "update") {
    await deploy(item, options, state.record);
    state.counts[action === "install" ? "installed" : "updated"] += 1;
  } else if (action === "in-sync") {
    state.record.entries[item.recordKey] = { hash: item.desiredHash! };
  } else if (action === "remove" || action === "forget") {
    if (action === "remove") {
      await rm(join(options.home, SKILLS_HOME, item.name), { recursive: true });
      state.counts.removed += 1;
    }
    delete state.record.entries[item.recordKey];
    if (plan.globalLock[item.name]) state.lockChanges.set(item.name, undefined);
    for (const directory of AGENT_LINK_DIRECTORIES) {
      await removeOwnedLink(join(options.home, directory.path, item.name), directory.prefix, state.roots);
    }
    return;
  } else {
    return;
  }
  if (item.desired?.lock) state.lockChanges.set(item.name, stableLock(item.desired.lock));
}

/** Only dead links go: a live one into the checkout points at untracked content someone still uses. */
async function pruneDeadLegacyLinks(directory: string, keep: ReadonlySet<string>, roots: readonly string[]) {
  const entries = await readdir(directory).catch(() => [] as string[]);
  for (const name of entries) {
    const path = join(directory, name);
    if (keep.has(name) || !(await lstat(path)).isSymbolicLink()) continue;
    const dangling = await stat(path).then(
      () => false,
      () => true
    );
    if (dangling && isLegacyLink(path, await readlink(path), roots)) await rm(path);
  }
}

async function syncAgentLinks(desired: DesiredSkills, options: SkillsOptions, roots: readonly string[]) {
  const linked = new Set([...desired.skills.keys(), ...desired.external]);
  for (const directory of AGENT_LINK_DIRECTORIES) {
    for (const name of linked) {
      if (!(await lstatOrUndefined(join(options.home, SKILLS_HOME, name)))) continue;
      await ensureLink(join(options.home, directory.path, name), `${directory.prefix}/${name}`, roots);
    }
    await pruneDeadLegacyLinks(join(options.home, directory.path), linked, roots);
  }
  const legacyExternal = join(options.home, ".agents/.external-skills.json");
  const external = await lstatOrUndefined(legacyExternal);
  if (external?.isSymbolicLink() && isLegacyLink(legacyExternal, await readlink(legacyExternal), roots)) {
    await rm(legacyExternal);
  }
}

async function executePlan(plan: SkillPlan, desired: DesiredSkills, options: SkillsOptions): Promise<string> {
  await prepareSkillDirectories(options);
  const state: ExecutionState = {
    counts: { installed: 0, removed: 0, updated: 0 },
    lockChanges: new Map(),
    record: await readDeployRecord(options.env, options.home),
    roots: await legacyRoots(options.checkoutRoot),
  };
  for (const item of plan.items) await executeItem(item, plan, options, state);
  await writeGlobalLock(options.home, state.roots, state.lockChanges);
  await syncAgentLinks(desired, options, state.roots);
  await writeDeployRecord(options.env, options.home, state.record);

  const { counts } = state;
  const pending = plan.items.filter((item) => item.decision.action === "unavailable").length;
  const parts = [
    `Skills deployed (${counts.installed} installed, ${counts.updated} updated, ${counts.removed} removed)`,
  ];
  if (plan.drift.length) parts.push(`${plan.drift.length} skill drift item(s); run 'dot reconcile'`);
  if (pending) parts.push(`${pending} vendored skill(s) unavailable`);
  return `${parts.join("\n")}\n`;
}

export async function inspectSkills(
  options: SkillsOptions & { readonly network: boolean }
): Promise<{ readonly desired: DesiredSkills; readonly plan: SkillPlan }> {
  const desired = await loadDesiredSkills(options);
  const record = await readDeployRecord(options.env, options.home);
  return { desired, plan: await planSkills({ ...options, desired, record }) };
}

export async function applySkills(options: SkillsOptions): Promise<string> {
  const { desired, plan } = await inspectSkills({ ...options, network: true });
  return executePlan(plan, desired, options);
}

/** A skill the repo has never heard of has no version to restore, so discarding it means removing it. */
async function discardUnrepoedSkill(
  options: SkillsOptions & { readonly name: string },
  plan: SkillPlan,
  desired: DesiredSkills
): Promise<string> {
  const path = join(options.home, SKILLS_HOME, options.name);
  if (desired.external.has(options.name) || !(await lstatOrUndefined(path))) {
    throw new Error(`no repo version of skill ${options.name} to restore`);
  }
  const roots = await legacyRoots(options.checkoutRoot);
  const record = await readDeployRecord(options.env, options.home);
  await rm(path, { force: true, recursive: true });
  delete record.entries[`${SKILLS_HOME}/${options.name}`];
  await writeDeployRecord(options.env, options.home, record);
  if (plan.globalLock[options.name])
    await writeGlobalLock(options.home, roots, new Map([[options.name, undefined]]));
  for (const directory of AGENT_LINK_DIRECTORIES) {
    await removeOwnedLink(join(options.home, directory.path, options.name), directory.prefix, roots);
  }
  return `Removed skill ${options.name} (not in the repo)\n`;
}

/** Discards drift for one skill by redeploying the repo version over whatever is in ~. */
export async function restoreSkill(options: SkillsOptions & { readonly name: string }): Promise<string> {
  const { desired, plan } = await inspectSkills({ ...options, network: true });
  const item = plan.items.find((candidate) => candidate.name === options.name);
  const want = desired.skills.get(options.name);
  if (item && !want) return discardUnrepoedSkill(options, plan, desired);
  if (!(item && want?.directory)) throw new Error(`no repo version of skill ${options.name} to restore`);
  const record = await readDeployRecord(options.env, options.home);
  await replaceDirectory(want.directory, join(options.home, SKILLS_HOME, options.name));
  record.entries[item.recordKey] = { hash: await hashDirectory(want.directory) };
  await writeDeployRecord(options.env, options.home, record);
  const roots = await legacyRoots(options.checkoutRoot);
  if (want.lock) await writeGlobalLock(options.home, roots, new Map([[options.name, stableLock(want.lock)]]));
  for (const directory of AGENT_LINK_DIRECTORIES) {
    await ensureLink(
      join(options.home, directory.path, options.name),
      `${directory.prefix}/${options.name}`,
      roots
    );
  }
  return `Restored skill ${options.name} from the repo\n`;
}
