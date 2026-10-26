import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DeployRecord } from "./deploy-record";
import type { DesiredSkill, DesiredSkills, LockEntry } from "./skill-sources";
import { hashDirectory, observe } from "./tree-hash";

export type DriftKind =
  | "added-locally"
  | "conflict"
  | "deleted-locally"
  | "modified-locally"
  | "vendored-added"
  | "vendored-updated";

export type Decision =
  | { readonly action: "forget" | "in-sync" | "install" | "remove" | "unavailable" | "update" }
  | { readonly action: "drift"; readonly kind: DriftKind };

/**
 * The three-way rule. `desired` is the repo version, `recorded` what dot last deployed,
 * `current` what is in ~ now; undefined means absent. Anything that could lose a local
 * change becomes drift instead of an action.
 */
export function decide(input: {
  readonly current?: string;
  readonly desired?: string;
  readonly recorded?: string;
}): Decision {
  const { current, desired, recorded } = input;
  if (desired !== undefined) {
    if (current === undefined) {
      return recorded === undefined ? { action: "install" } : { action: "drift", kind: "deleted-locally" };
    }
    if (current === desired) return { action: "in-sync" };
    if (recorded === current) return { action: "update" };
    if (recorded === desired) return { action: "drift", kind: "modified-locally" };
    return { action: "drift", kind: "conflict" };
  }
  if (recorded !== undefined) {
    if (current === undefined) return { action: "forget" };
    return recorded === current ? { action: "remove" } : { action: "drift", kind: "conflict" };
  }
  return current === undefined ? { action: "forget" } : { action: "drift", kind: "added-locally" };
}

export const SKILLS_HOME = ".agents/skills";
export const GLOBAL_LOCK = ".agents/.skill-lock.json";

export interface SkillPlanItem {
  readonly currentHash?: string;
  readonly decision: Decision;
  readonly desired?: DesiredSkill;
  readonly desiredHash?: string;
  readonly name: string;
  readonly recordKey: string;
}

export interface DriftItem {
  readonly currentHash?: string;
  readonly fingerprint: string;
  readonly globalLockEntry?: LockEntry;
  readonly homePath: string;
  readonly kind: DriftKind;
  readonly name: string;
  readonly repoLockEntry?: LockEntry;
  /** Where an absorbed copy belongs in the checkout; vendored skills absorb via skills/lock.json. */
  readonly repoPath: string;
  readonly skillKind: "local" | "unknown" | "vendored";
}

export interface SkillPlan {
  readonly drift: readonly DriftItem[];
  readonly globalLock: Readonly<Record<string, LockEntry>>;
  readonly items: readonly SkillPlanItem[];
}

/** Paths that resolve into a checkout's stowed `home/` are links from the old stow layout. */
export async function legacyRoots(checkoutRoot: string): Promise<readonly string[]> {
  const roots = new Set([join(checkoutRoot, "home")]);
  const real = await realpath(checkoutRoot).catch(() => undefined);
  if (real) roots.add(join(real, "home"));
  return [...roots];
}

export function isLegacyLink(linkPath: string, target: string, roots: readonly string[]): boolean {
  const resolved = resolve(dirname(linkPath), target);
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
}

/** Reads the skills CLI's own global lock, ignoring the old stow link into the checkout. */
export async function readGlobalLock(home: string): Promise<Record<string, LockEntry>> {
  const path = join(home, GLOBAL_LOCK);
  try {
    if (!(await lstat(path)).isFile()) return {};
    const parsed = JSON.parse(await readFile(path, "utf8")) as { skills?: Record<string, LockEntry> };
    return parsed.skills ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function currentHash(path: string, roots: readonly string[]): Promise<string | undefined> {
  const observed = await observe(path);
  if (observed.kind === "absent") return undefined;
  if (observed.kind === "directory") return observed.hash;
  if (observed.kind === "link") {
    if (isLegacyLink(path, observed.target, roots)) return undefined;
    // A foreign link never matches a content hash, so it can only surface as drift.
    return `link:${observed.target}`;
  }
  return "other";
}

function refine(kind: DriftKind, item: SkillPlanItem, globalEntry: LockEntry | undefined): DriftKind {
  const repoEntry = item.desired?.lock;
  if (
    (kind === "modified-locally" || kind === "conflict") &&
    repoEntry &&
    globalEntry &&
    globalEntry.skillFolderHash !== repoEntry.skillFolderHash
  ) {
    return "vendored-updated";
  }
  if (kind === "added-locally" && globalEntry) return "vendored-added";
  return kind;
}

async function candidateNames(
  skillsHome: string,
  desired: DesiredSkills,
  record: DeployRecord
): Promise<string[]> {
  const names = new Set(desired.skills.keys());
  for (const key of Object.keys(record.entries)) {
    if (key.startsWith(`${SKILLS_HOME}/`)) names.add(key.slice(SKILLS_HOME.length + 1));
  }
  const present = await readdir(skillsHome).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const name of present) if (!name.startsWith(".")) names.add(name);
  for (const name of desired.external) names.delete(name);
  return [...names].sort();
}

function driftItem(
  item: SkillPlanItem,
  kind: DriftKind,
  skillsHome: string,
  globalEntry?: LockEntry
): DriftItem {
  const vendored = item.desired?.kind === "vendored" || kind === "vendored-added";
  let skillKind: DriftItem["skillKind"] = globalEntry ? "vendored" : "unknown";
  if (item.desired) skillKind = item.desired.kind;
  return {
    currentHash: item.currentHash,
    fingerprint: `${kind}:${item.name}:${item.currentHash ?? "absent"}`,
    globalLockEntry: globalEntry,
    homePath: join(skillsHome, item.name),
    kind,
    name: item.name,
    repoLockEntry: item.desired?.lock,
    repoPath: vendored ? "skills/lock.json" : `skills/local/${item.name}`,
    skillKind,
  };
}

export async function planSkills(options: {
  readonly checkoutRoot: string;
  readonly desired: DesiredSkills;
  readonly home: string;
  readonly record: DeployRecord;
}): Promise<SkillPlan> {
  const { desired, home, record } = options;
  const roots = await legacyRoots(options.checkoutRoot);
  const skillsHome = join(home, SKILLS_HOME);
  const globalLock = await readGlobalLock(home);
  const items: SkillPlanItem[] = [];
  const drift: DriftItem[] = [];
  for (const name of await candidateNames(skillsHome, desired, record)) {
    const recordKey = `${SKILLS_HOME}/${name}`;
    const want = desired.skills.get(name);
    const current = await currentHash(join(skillsHome, name), roots);
    if (want && !want.directory) {
      items.push({
        currentHash: current,
        decision: { action: "unavailable" },
        desired: want,
        name,
        recordKey,
      });
      continue;
    }
    const desiredHash = want?.directory ? await hashDirectory(want.directory) : undefined;
    const base = { currentHash: current, desired: want, desiredHash, name, recordKey };
    let decision = decide({ current, desired: desiredHash, recorded: record.entries[recordKey]?.hash });
    if (decision.action === "drift") {
      const kind = refine(decision.kind, { ...base, decision }, globalLock[name]);
      decision = { action: "drift", kind };
      drift.push(driftItem({ ...base, decision }, kind, skillsHome, globalLock[name]));
    }
    items.push({ ...base, decision });
  }
  return { drift, globalLock, items };
}
