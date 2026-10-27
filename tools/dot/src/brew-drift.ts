import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessRunner } from "./process";

export interface BrewDriftItem {
  readonly domain: "brew";
  readonly fingerprint: string;
  readonly kind: "installed-undeclared";
  readonly name: string;
  readonly package: "cask" | "formula" | "tap";
  /** Where an absorbed package belongs in the checkout. */
  readonly repoPath: "packages/bundle";
}

const SECTIONS: Readonly<Record<string, BrewDriftItem["package"]>> = {
  "Would uninstall casks:": "cask",
  "Would uninstall formulae:": "formula",
  "Would untap:": "tap",
};

/** Reads the package sections of `brew bundle cleanup` (a dry run); cache and log cleanup is not drift. */
export function parseBrewCleanup(stdout: string): BrewDriftItem[] {
  const items: BrewDriftItem[] = [];
  let section: BrewDriftItem["package"] | undefined;
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
export async function inspectBrewDrift(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}): Promise<BrewDriftItem[]> {
  const bundle = join(options.checkoutRoot, "packages/bundle");
  if (!(await lstat(bundle).catch(() => undefined))?.isFile()) return [];
  try {
    const result = await options.processes.run({
      argv: ["brew", "bundle", "cleanup", "--file", bundle],
      cwd: options.checkoutRoot,
      env: { ...options.env, HOMEBREW_NO_AUTO_UPDATE: "1" },
    });
    return parseBrewCleanup(result.stdout);
  } catch {
    return [];
  }
}
