import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { replaceFileAtomic } from "./atomic-file";
import { parseJsonObject } from "./json";

async function readRuntime(path: string): Promise<Record<string, unknown>> {
  try {
    return parseJsonObject(await readFile(path, "utf8"), "Claude runtime settings");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function currentRegularFileMatches(path: string, desired: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) return false;
    return (await readFile(path, "utf8")) === desired;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface ClaudeSettingsPlan {
  readonly changed: boolean;
  readonly desired: string;
  readonly settingsPath: string;
  readonly tracked: boolean;
}

export async function planClaudeSettings(options: {
  readonly checkoutRoot: string;
  readonly home: string;
}): Promise<ClaudeSettingsPlan> {
  const defaultsPath = join(options.checkoutRoot, "home/.claude/settings.defaults.json");
  const settingsPath = join(options.home, ".claude/settings.json");

  let defaults: Record<string, unknown> | undefined;
  try {
    defaults = parseJsonObject(await readFile(defaultsPath, "utf8"), "Tracked Claude settings defaults");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (!defaults) {
    return { changed: false, desired: "", settingsPath, tracked: false };
  }

  const current = await readRuntime(settingsPath);
  const desired = `${JSON.stringify({ ...defaults, ...current }, null, 2)}\n`;

  return {
    changed: !(await currentRegularFileMatches(settingsPath, desired)),
    desired,
    settingsPath,
    tracked: true,
  };
}

export async function applyClaudeSettings(plan: ClaudeSettingsPlan): Promise<boolean> {
  if (!(plan.changed && plan.tracked)) return false;
  await mkdir(dirname(plan.settingsPath), { mode: 0o700, recursive: true });
  await replaceFileAtomic(plan.settingsPath, plan.desired, { mode: 0o600, sync: true });
  return true;
}
