import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFileAtomic } from "./atomic-file";
import type { ProcessRunner } from "./process";

export interface GlobalBunPackage {
  readonly name: string;
  readonly version?: string;
}

interface ReconcileOptions {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}

const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const INSTALLED_LINE =
  /^[├└│\s]*(?:├──|└──)\s*((?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)@(\S+)\s*$/i;

function manifestPath(checkoutRoot: string): string {
  return join(checkoutRoot, "packages/bun-global");
}

export function parseGlobalBunPackage(spec: string): GlobalBunPackage | undefined {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  let name: string;
  let version: string | undefined;

  if (trimmed.startsWith("@")) {
    const scopeEnd = trimmed.indexOf("/");
    if (scopeEnd === -1) return undefined;
    const versionStart = trimmed.indexOf("@", scopeEnd + 1);
    if (versionStart === -1) {
      name = trimmed;
    } else {
      name = trimmed.slice(0, versionStart);
      version = trimmed.slice(versionStart + 1);
    }
  } else {
    const versionStart = trimmed.indexOf("@");
    if (versionStart === -1) {
      name = trimmed;
    } else {
      name = trimmed.slice(0, versionStart);
      version = trimmed.slice(versionStart + 1);
    }
  }

  if (!PACKAGE_NAME.test(name)) return undefined;
  if (version === "") return undefined;

  return { name, version };
}

function formatGlobalBunPackage(pkg: GlobalBunPackage): string {
  return pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;
}

async function readManifest(checkoutRoot: string): Promise<GlobalBunPackage[]> {
  let text: string;
  try {
    text = await readFile(manifestPath(checkoutRoot), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .map(parseGlobalBunPackage)
    .filter((pkg): pkg is GlobalBunPackage => pkg !== undefined);
}

async function listInstalledGlobal(options: ReconcileOptions): Promise<Map<string, string>> {
  const result = await options.processes.run({
    argv: ["bun", "pm", "ls", "-g"],
    cwd: options.checkoutRoot,
    env: options.env,
  });
  const installed = new Map<string, string>();
  if (result.exitCode !== 0) return installed;
  for (const line of result.stdout.split("\n")) {
    const match = line.match(INSTALLED_LINE);
    if (match) {
      installed.set(match[1]!, match[2]!);
    }
  }
  return installed;
}

export async function inspectGlobalBunPackages(options: ReconcileOptions): Promise<boolean> {
  const manifest = await readManifest(options.checkoutRoot);
  if (manifest.length === 0) return true;
  const installed = await listInstalledGlobal(options);
  return manifest.every((pkg) => {
    const installedVersion = installed.get(pkg.name);
    if (!installedVersion) return false;
    return !pkg.version || installedVersion === pkg.version;
  });
}

export async function reconcileGlobalBunPackages(options: ReconcileOptions): Promise<string> {
  const manifest = await readManifest(options.checkoutRoot);
  if (manifest.length === 0) return "";

  const installed = await listInstalledGlobal(options);
  const missing: GlobalBunPackage[] = [];
  for (const pkg of manifest) {
    const installedVersion = installed.get(pkg.name);
    if (!installedVersion || (pkg.version && installedVersion !== pkg.version)) {
      missing.push(pkg);
    }
  }

  if (missing.length === 0) return "Global Bun packages already current\n";

  const result = await options.processes.run({
    argv: ["bun", "add", "-g", ...missing.map(formatGlobalBunPackage)],
    cwd: options.checkoutRoot,
    env: options.env,
    output: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error("failed to install declared global Bun packages");
  }
  return `Installed ${missing.length} global Bun package(s)\n`;
}

export async function addGlobalBunPackage(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly name: string;
  readonly processes: ProcessRunner;
}): Promise<string> {
  const pkg = parseGlobalBunPackage(options.name);
  if (!pkg) throw new Error("invalid global Bun package name");

  const manifest = await readManifest(options.checkoutRoot);
  if (manifest.some((existing) => existing.name === pkg.name)) {
    throw new Error(`global Bun package '${pkg.name}' is already declared`);
  }

  const sorted = [...manifest, pkg].sort((a, b) => a.name.localeCompare(b.name));
  await replaceFileAtomic(
    manifestPath(options.checkoutRoot),
    `${sorted.map(formatGlobalBunPackage).join("\n")}\n`
  );

  const result = await options.processes.run({
    argv: ["bun", "add", "-g", formatGlobalBunPackage(pkg)],
    cwd: options.checkoutRoot,
    env: options.env,
    output: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `global Bun package installation failed; '${pkg.name}' remains declared for the next dot apply`
    );
  }
  return `Added and installed global Bun package '${formatGlobalBunPackage(pkg)}'\n`;
}

export async function removeGlobalBunPackage(options: {
  readonly checkoutRoot: string;
  readonly name: string;
}): Promise<string> {
  const pkg = parseGlobalBunPackage(options.name);
  if (!pkg) throw new Error("invalid global Bun package name");

  const manifest = await readManifest(options.checkoutRoot);
  const filtered = manifest.filter((existing) => existing.name !== pkg.name);
  if (filtered.length === manifest.length) {
    return `Global Bun package '${pkg.name}' is not declared\n`;
  }

  await replaceFileAtomic(
    manifestPath(options.checkoutRoot),
    `${filtered.map(formatGlobalBunPackage).join("\n")}\n`
  );
  return `Removed global Bun package '${pkg.name}' from the manifest\n`;
}
