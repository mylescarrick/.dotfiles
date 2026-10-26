import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { cacheDirectory } from "./deploy-record";
import type { ProcessRunner } from "./process";

/** The stable subset of a skills CLI lock entry. Install timestamps stay out of the repo. */
export interface LockEntry {
  readonly skillFolderHash: string;
  readonly skillPath: string;
  readonly source: string;
  readonly sourceType: string;
  readonly sourceUrl: string;
}

export interface DesiredSkill {
  /** Undefined when a vendored tree is not cached and the caller forbade network access. */
  readonly directory: string | undefined;
  readonly kind: "local" | "vendored";
  readonly lock?: LockEntry;
  readonly name: string;
}

export interface DesiredSkills {
  readonly external: ReadonlySet<string>;
  readonly skills: ReadonlyMap<string, DesiredSkill>;
}

export const LOCK_FIELDS = ["source", "sourceType", "sourceUrl", "skillPath", "skillFolderHash"] as const;

export function validateSkillName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`invalid skill name: ${name}`);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function readSkillLock(checkoutRoot: string): Promise<Record<string, LockEntry>> {
  const lock = await readJson<{ skills?: Record<string, LockEntry> }>(
    join(checkoutRoot, "skills/lock.json"),
    {}
  );
  return lock.skills ?? {};
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

interface FetchOptions {
  readonly cacheRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}

async function git(options: FetchOptions, argv: readonly string[], failure: string): Promise<void> {
  const result = await options.processes.run({
    argv: ["git", ...argv],
    cwd: options.cacheRoot,
    env: options.env,
  });
  if (result.exitCode !== 0) throw new Error(`${failure}: ${result.stderr.trim()}`);
}

/**
 * The lock's skillFolderHash is a git tree ID, so archiving it from the source repo
 * reproduces the skill exactly. Trees are immutable, so a cached extraction never goes stale.
 */
async function materialize(options: FetchOptions, name: string, entry: LockEntry): Promise<string> {
  const destination = join(options.cacheRoot, "skills", entry.skillFolderHash);
  if (await exists(destination)) return destination;

  const repository = join(options.cacheRoot, "git", entry.sourceUrl.replace(/[^a-zA-Z0-9.-]+/g, "_"));
  if (!(await exists(repository))) {
    await mkdir(join(options.cacheRoot, "git"), { recursive: true });
    await git(
      options,
      ["clone", "--quiet", "--bare", "--filter=blob:none", entry.sourceUrl, repository],
      `failed to clone ${entry.sourceUrl}`
    );
  }
  const present = await options.processes.run({
    argv: ["git", "-C", repository, "cat-file", "-e", `${entry.skillFolderHash}^{tree}`],
    cwd: options.cacheRoot,
    env: options.env,
  });
  if (present.exitCode !== 0) {
    await git(
      options,
      ["-C", repository, "fetch", "--quiet", "origin", "+refs/heads/*:refs/heads/*"],
      `failed to fetch ${entry.sourceUrl}`
    );
  }

  await mkdir(join(options.cacheRoot, "skills"), { recursive: true });
  const staging = await mkdtemp(join(options.cacheRoot, "skills", `.${name}-`));
  try {
    const archive = join(staging, "tree.tar");
    const extracted = join(staging, "tree");
    await mkdir(extracted);
    await git(
      options,
      ["-C", repository, "archive", "--format=tar", "-o", archive, entry.skillFolderHash],
      `skill ${name}: tree ${entry.skillFolderHash} not found in ${entry.sourceUrl}`
    );
    const untar = await options.processes.run({
      argv: ["tar", "-xf", archive, "-C", extracted],
      cwd: options.cacheRoot,
      env: options.env,
    });
    if (untar.exitCode !== 0) throw new Error(`failed to extract skill ${name}`);
    await rename(extracted, destination).catch(async (error: unknown) => {
      // A concurrent run may have won the race; its tree is identical by construction.
      if (!(await exists(destination))) throw error;
    });
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
  return destination;
}

export async function loadDesiredSkills(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly network: boolean;
  readonly processes: ProcessRunner;
}): Promise<DesiredSkills> {
  const skills = new Map<string, DesiredSkill>();
  const localRoot = join(options.checkoutRoot, "skills/local");
  const localEntries = await readdir(localRoot, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of localEntries) {
    if (!entry.isDirectory()) continue;
    validateSkillName(entry.name);
    skills.set(entry.name, { directory: join(localRoot, entry.name), kind: "local", name: entry.name });
  }

  const fetchOptions: FetchOptions = {
    cacheRoot: cacheDirectory(options.env, options.home),
    env: options.env,
    processes: options.processes,
  };
  for (const [name, entry] of Object.entries(await readSkillLock(options.checkoutRoot))) {
    validateSkillName(name);
    if (skills.has(name)) throw new Error(`skill ${name} is both local and vendored`);
    const cached = join(fetchOptions.cacheRoot, "skills", entry.skillFolderHash);
    let directory: string | undefined;
    if (options.network) directory = await materialize(fetchOptions, name, entry);
    else if (await exists(cached)) directory = cached;
    skills.set(name, { directory, kind: "vendored", lock: entry, name });
  }

  const external = await readJson<{ skills?: string[] }>(
    join(options.checkoutRoot, "skills/external.json"),
    {}
  );
  for (const name of external.skills ?? []) validateSkillName(name);
  return { external: new Set(external.skills ?? []), skills };
}
