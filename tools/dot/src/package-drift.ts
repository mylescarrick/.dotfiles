import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { listInstalledGlobal, readManifest } from "./bun-global";
import { parseJsonObject } from "./json";
import { localPiPackages } from "./pi";
import type { ProcessRunner } from "./process";

/** Something installed by hand that no tracked file declares. `domain` says which tool owns it. */
export interface PackageDriftItem {
  readonly domain: "brew" | "bun" | "pi";
  readonly fingerprint: string;
  readonly kind: "installed-undeclared";
  readonly name: string;
  readonly package: "cask" | "extension" | "formula" | "global" | "tap";
  /** Where an absorbed package belongs in the checkout. */
  readonly repoPath: "config/pi/settings.defaults.json" | "packages/bun-global" | "packages/bundle";
}

interface Options {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly processes: ProcessRunner;
}

const SECTIONS: Readonly<Record<string, PackageDriftItem["package"]>> = {
  "Would uninstall casks:": "cask",
  "Would uninstall formulae:": "formula",
  "Would untap:": "tap",
};

/** Reads the package sections of `brew bundle cleanup` (a dry run); cache and log cleanup is not drift. */
export function parseBrewCleanup(stdout: string): PackageDriftItem[] {
  const items: PackageDriftItem[] = [];
  let section: PackageDriftItem["package"] | undefined;
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (text.startsWith("Would ") || text.startsWith("Run ")) {
      section = SECTIONS[text];
      continue;
    }
    if (!(section && text)) continue;
    for (const name of text.split(/\s+/)) {
      items.push({
        domain: "brew",
        fingerprint: `installed-undeclared:${section}:${name}`,
        kind: "installed-undeclared",
        name,
        package: section,
        repoPath: "packages/bundle",
      });
    }
  }
  return items;
}

/**
 * Packages installed on this machine that the Brewfile does not declare. Best effort: a missing
 * Homebrew or Brewfile means no drift to report, not a failed reconcile.
 */
async function inspectBrewDrift(options: Options): Promise<PackageDriftItem[]> {
  const bundle = join(options.checkoutRoot, "packages/bundle");
  if (!(await lstat(bundle).catch(() => undefined))?.isFile()) return [];
  const result = await options.processes.run({
    argv: ["brew", "bundle", "cleanup", "--file", bundle],
    cwd: options.checkoutRoot,
    env: { ...options.env, HOMEBREW_NO_AUTO_UPDATE: "1" },
  });
  return parseBrewCleanup(result.stdout);
}

function undeclared(
  domain: PackageDriftItem["domain"],
  pkg: PackageDriftItem["package"],
  name: string,
  repoPath: PackageDriftItem["repoPath"]
): PackageDriftItem {
  return {
    domain,
    fingerprint: `installed-undeclared:${domain}:${name}`,
    kind: "installed-undeclared",
    name,
    package: pkg,
    repoPath,
  };
}

/** Global Bun packages that `packages/bun-global` does not list. */
async function inspectBunDrift(options: Options): Promise<PackageDriftItem[]> {
  // No manifest means nothing to compare against, the same rule brew follows for a missing Brewfile.
  if (!(await lstat(join(options.checkoutRoot, "packages/bun-global")).catch(() => undefined))?.isFile())
    return [];
  const declared = new Set((await readManifest(options.checkoutRoot)).map((pkg) => pkg.name));
  const installed = await listInstalledGlobal(options);
  return [...installed.keys()]
    .filter((name) => !declared.has(name))
    .map((name) => undeclared("bun", "global", name, "packages/bun-global"));
}

/** Pi packages in the runtime settings that the tracked defaults do not list. */
async function inspectPiDrift(options: Options): Promise<PackageDriftItem[]> {
  const read = async (path: string) => parseJsonObject(await readFile(path, "utf8"), "Pi settings");
  const defaults = await read(join(options.checkoutRoot, "config/pi/settings.defaults.json"));
  const runtime = await read(join(options.home, ".pi/agent/settings.json")).catch(() => ({}));
  return localPiPackages(defaults, runtime).map((source) =>
    undeclared("pi", "extension", source, "config/pi/settings.defaults.json")
  );
}

/** Each source is best effort and independent: a missing tool or file means no drift from it, not a failed reconcile. */
export async function inspectPackageDrift(options: Options): Promise<PackageDriftItem[]> {
  const safely = (check: () => Promise<PackageDriftItem[]>) => check().catch(() => []);
  const [brew, bun, pi] = await Promise.all([
    safely(() => inspectBrewDrift(options)),
    safely(() => inspectBunDrift(options)),
    safely(() => inspectPiDrift(options)),
  ]);
  return [...brew, ...bun, ...pi];
}
