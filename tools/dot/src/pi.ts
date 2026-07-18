import {
  lstat,
  mkdir,
  readFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { replaceFileAtomic } from "./atomic-file";
import { parseJsonObject } from "./json";

async function readRuntime(path: string): Promise<Record<string, unknown>> {
  try {
    return parseJsonObject(await readFile(path, "utf8"), "Pi runtime settings");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function currentRegularFileMatches(
  path: string,
  desired: string,
): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) return false;
    return (await readFile(path, "utf8")) === desired;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function replacePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await replaceFileAtomic(path, content, { mode: 0o600, sync: true });
}

export async function inspectPiSettings(home: string): Promise<string[]> {
  const path = join(home, ".pi/agent/settings.json");
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ["Pi runtime settings are missing"];
    }
    throw error;
  }
  if (!metadata.isFile()) return ["Pi runtime settings are not a private regular file"];

  const issues: string[] = [];
  if ((metadata.mode & 0o777) !== 0o600) issues.push("Pi runtime settings mode is not 0600");
  try {
    parseJsonObject(await readFile(path, "utf8"), "Pi runtime settings");
  } catch (error) {
    issues.push((error as Error).message);
  }
  return issues;
}

export interface PiSettingsPlan {
  readonly changed: boolean;
  readonly desired: string;
  readonly settingsPath: string;
}

export async function planPiSettings(options: {
  readonly checkoutRoot: string;
  readonly home: string;
}): Promise<PiSettingsPlan> {
  const defaultsPath = join(options.checkoutRoot, "config/pi/settings.defaults.json");
  const settingsPath = join(options.home, ".pi/agent/settings.json");

  let defaults: Record<string, unknown>;
  try {
    defaults = parseJsonObject(
      await readFile(defaultsPath, "utf8"),
      "Tracked Pi settings defaults",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`tracked Pi settings defaults are missing at ${defaultsPath}`);
    }
    throw error;
  }

  const current = await readRuntime(settingsPath);
  const merged = { ...defaults, ...current };
  if (Object.hasOwn(defaults, "packages")) merged.packages = defaults.packages;
  const desired = `${JSON.stringify(merged, null, 2)}\n`;

  return {
    changed: !(await currentRegularFileMatches(settingsPath, desired)),
    desired,
    settingsPath,
  };
}

export async function applyPiSettings(plan: PiSettingsPlan): Promise<boolean> {
  if (!plan.changed) return false;
  await replacePrivateFile(plan.settingsPath, plan.desired);
  return true;
}
