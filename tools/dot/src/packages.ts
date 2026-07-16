import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessRunner } from "./process";

interface PackageOptions {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}

function homebrewEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return {
    ...env,
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_BUNDLE_BREW_SKIP: undefined,
    HOMEBREW_BUNDLE_CASK_SKIP: undefined,
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
  env: Readonly<Record<string, string | undefined>>,
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
