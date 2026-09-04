import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { replaceFileAtomic } from "./atomic-file";
import type { ProcessRunner } from "./process";

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

interface InstallState {
  readonly lock: string;
  readonly manifests: string;
  readonly piVersion: string;
  readonly schema: 2;
}

async function existsDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function manifestDigest(root: string): Promise<string> {
  const manifests: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "package.json") manifests.push(path);
    }
  }
  await visit(root);
  const hash = createHash("sha256");
  for (const path of manifests.sort(compareStrings)) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function fileDigest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function readState(path: string): Promise<InstallState | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      value &&
      typeof value === "object" &&
      (value as InstallState).schema === 2 &&
      typeof (value as InstallState).manifests === "string" &&
      typeof (value as InstallState).lock === "string" &&
      typeof (value as InstallState).piVersion === "string"
    ) {
      return value as InstallState;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeState(path: string, state: InstallState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await replaceFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function installedPiVersion(options: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}): Promise<string> {
  const result = await options.processes.run({
    argv: ["pi", "--version"],
    cwd: options.cwd,
    env: options.env,
    output: "capture",
  });
  const version = result.stdout.trim();
  if (result.exitCode !== 0 || !version) {
    const detail = result.stderr.trim() || version || "no version output";
    throw new Error(`failed to determine Pi version (exit ${result.exitCode}): ${detail}`);
  }
  return version;
}

export async function reconcilePiDependencies(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly processes: ProcessRunner;
}): Promise<string> {
  const trackedWorkspace = join(options.checkoutRoot, "home/.pi");
  const trackedRootManifest = join(trackedWorkspace, "package.json");
  if (!(await regularFile(trackedRootManifest))) {
    return "Pi dependency workspace not tracked (skipped)\n";
  }

  const liveWorkspace = join(options.home, ".pi");
  const liveManifest = join(liveWorkspace, "package.json");
  if (!(await regularFile(liveManifest))) {
    throw new Error(`Pi workspace was not published at ${liveManifest}`);
  }

  const nodeModules = join(liveWorkspace, "node_modules");
  const lockPath = join(liveWorkspace, "bun.lock");
  const statePath = join(nodeModules, ".dotfiles-install-state.json");
  const piVersion = await installedPiVersion({
    cwd: liveWorkspace,
    env: options.env,
    processes: options.processes,
  });
  const manifests = await manifestDigest(trackedWorkspace);
  const lockRegular = await regularFile(lockPath);
  const lock = lockRegular ? await fileDigest(lockPath) : undefined;
  const current = await readState(statePath);
  if (
    (await existsDirectory(nodeModules)) &&
    lock &&
    current?.manifests === manifests &&
    current.lock === lock &&
    current.piVersion === piVersion
  ) {
    return "Pi dependencies already current\n";
  }

  const result = await options.processes.run({
    argv: ["bun", "install"],
    cwd: liveWorkspace,
    env: options.env,
    output: "inherit",
  });
  if (result.exitCode !== 0) throw new Error("failed to install Pi workspace dependencies");
  if (!((await existsDirectory(nodeModules)) && (await regularFile(lockPath)))) {
    throw new Error("Pi dependency install did not produce node_modules and bun.lock");
  }
  await writeState(statePath, {
    lock: await fileDigest(lockPath),
    manifests,
    piVersion,
    schema: 2,
  });
  return "Pi dependencies installed\n";
}
