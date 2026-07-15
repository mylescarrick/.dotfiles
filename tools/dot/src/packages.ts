import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessRunner } from "./process";

export async function reconcilePackages(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}): Promise<string> {
  const bundle = join(options.checkoutRoot, "packages/bundle");
  try {
    if (!(await lstat(bundle)).isFile()) throw new Error();
  } catch {
    throw new Error(`Brewfile is missing at ${bundle}`);
  }

  const env = {
    ...options.env,
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_BUNDLE_BREW_SKIP: undefined,
    HOMEBREW_BUNDLE_CASK_SKIP: undefined,
  };
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
  if (check.exitCode === 0) return "Packages already current\n";

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
