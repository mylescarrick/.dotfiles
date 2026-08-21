import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessRunner } from "./process";

const CASK_TOKEN_RE = /^\s*cask\s+"([^"]+)"/;

interface PackageOptions {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}

function homebrewEnvironment(
  env: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string | undefined>> {
  return {
    ...env,
    HOMEBREW_BUNDLE_BREW_SKIP: undefined,
    HOMEBREW_BUNDLE_CASK_SKIP: undefined,
    HOMEBREW_NO_AUTO_UPDATE: "1",
  };
}

async function bundlePath(checkoutRoot: string): Promise<string> {
  const bundle = join(checkoutRoot, "packages/bundle");
  try {
    if (!(await lstat(bundle)).isFile()) throw new Error();
  } catch {
    throw new Error(`Brewfile is missing at ${bundle}`);
  }
  return bundle;
}

async function checkPackages(
  options: PackageOptions,
  bundle: string,
  env: Readonly<Record<string, string | undefined>>
): Promise<boolean> {
  let check;
  try {
    check = await options.processes.run({
      argv: ["brew", "bundle", "check", "--no-upgrade", "--file", bundle],
      cwd: options.checkoutRoot,
      env,
    });
  } catch {
    throw new Error("Homebrew is required; run 'dot init'");
  }
  return check.exitCode === 0;
}

export async function inspectPackages(options: PackageOptions): Promise<boolean> {
  const bundle = await bundlePath(options.checkoutRoot);
  return checkPackages(options, bundle, homebrewEnvironment(options.env));
}

async function bundleCaskTokens(bundle: string): Promise<readonly string[]> {
  const content = await readFile(bundle, "utf8");
  const tokens: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(CASK_TOKEN_RE);
    if (match) tokens.push(match[1] as string);
  }
  return tokens;
}

async function caskArtifactTargets(
  options: PackageOptions,
  env: Readonly<Record<string, string | undefined>>,
  token: string
): Promise<readonly string[]> {
  const info = await options.processes.run({
    argv: ["brew", "info", "--cask", token, "--json=v2"],
    cwd: options.checkoutRoot,
    env,
  });
  if (info.exitCode !== 0) return [];

  try {
    const parsed = JSON.parse(info.stdout) as {
      casks?: readonly { artifacts?: readonly Record<string, unknown>[] }[];
    };
    const artifacts = parsed.casks?.[0]?.artifacts ?? [];
    return artifacts
      .map((artifact) => artifact.target)
      .filter((target): target is string => typeof target === "string");
  } catch {
    return [];
  }
}

async function isCaskStale(
  options: PackageOptions,
  env: Readonly<Record<string, string | undefined>>,
  token: string
): Promise<boolean> {
  const targets = await caskArtifactTargets(options, env, token);
  for (const target of targets) {
    try {
      await lstat(target);
    } catch {
      return true;
    }
  }
  return false;
}

/** Casks Homebrew still considers installed but whose linked artifacts (the .app, its CLI symlink, etc.) are gone from disk — e.g. the user dragged the app to the Trash instead of uninstalling it. */
export async function findStaleCasks(options: PackageOptions): Promise<readonly string[]> {
  const bundle = await bundlePath(options.checkoutRoot);
  const env = homebrewEnvironment(options.env);
  const tokens = await bundleCaskTokens(bundle);
  const stale: string[] = [];
  for (const token of tokens) {
    if (await isCaskStale(options, env, token)) stale.push(token);
  }
  return stale;
}

export async function repairStaleCasks(options: PackageOptions): Promise<string> {
  const stale = await findStaleCasks(options);
  if (stale.length === 0) return "No stale casks found\n";

  const env = homebrewEnvironment(options.env);
  for (const token of stale) {
    const reinstall = await options.processes.run({
      argv: ["brew", "reinstall", "--cask", token],
      cwd: options.checkoutRoot,
      env,
      output: "inherit",
    });
    if (reinstall.exitCode !== 0) {
      throw new Error(`failed to reinstall stale cask ${token}`);
    }
  }
  return `Reinstalled stale casks: ${stale.join(", ")}\n`;
}

export async function reconcilePackages(options: PackageOptions): Promise<string> {
  const bundle = await bundlePath(options.checkoutRoot);
  const env = homebrewEnvironment(options.env);
  if (await checkPackages(options, bundle, env)) return "Packages already current\n";

  const install = await options.processes.run({
    argv: ["brew", "bundle", "install", "--no-upgrade", "--file", bundle],
    cwd: options.checkoutRoot,
    env,
  });
  if (install.exitCode !== 0) {
    throw new Error("failed to install declared Brewfile packages");
  }
  return "Declared packages installed\n";
}
