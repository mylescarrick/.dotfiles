import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseJsonObject } from "./json";
import type { ProcessRunner } from "./process";

export function parseNpmPackageName(source: string): string | undefined {
  const prefix = "npm:";
  if (!source.startsWith(prefix)) return undefined;

  const rest = source.slice(prefix.length);
  if (rest.startsWith("@")) {
    const slashIndex = rest.indexOf("/");
    if (slashIndex === -1) return undefined;

    const versionAt = rest.indexOf("@", slashIndex + 1);
    return versionAt === -1 ? rest : rest.slice(0, versionAt);
  }

  const versionAt = rest.indexOf("@");
  return versionAt === -1 ? rest : rest.slice(0, versionAt);
}

export async function reconcilePiPackages(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly processes: ProcessRunner;
}): Promise<string> {
  const settingsPath = join(options.checkoutRoot, "config/pi/settings.defaults.json");
  const settings = parseJsonObject(await readFile(settingsPath, "utf8"), "Tracked Pi settings defaults");
  const desired = Array.isArray(settings.packages)
    ? settings.packages.filter(
        (source): source is string => typeof source === "string" && source.startsWith("npm:")
      )
    : [];

  if (desired.length === 0) {
    return "Pi packages already current\n";
  }

  const installedPath = join(options.home, ".pi/agent/npm/package.json");
  let installed = new Set<string>();
  try {
    const manifest = parseJsonObject(await readFile(installedPath, "utf8"), "Pi npm package manifest");
    const dependencies = manifest.dependencies;
    if (dependencies !== null && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      installed = new Set(Object.keys(dependencies as Record<string, unknown>));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const missing = desired.filter((source) => {
    const name = parseNpmPackageName(source);
    return name !== undefined && !installed.has(name);
  });

  if (missing.length === 0) {
    return "Pi packages already current\n";
  }

  for (const source of missing) {
    const result = await options.processes.run({
      argv: ["pi", "install", source],
      cwd: options.home,
      env: options.env,
      output: "inherit",
    });
    if (result.exitCode !== 0) {
      throw new Error(`failed to install Pi package ${source}`);
    }
  }

  return "Pi packages installed\n";
}
