import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFileAtomic } from "./atomic-file";
import type { ProcessRunner } from "./process";

function validateName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9@+._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9@+._-]*)*$/.test(name)) {
    throw new Error("invalid package name");
  }
}

function parsePackageLine(line: string): { name: string; type: "brew" | "cask" } | undefined {
  const match = line.match(/^(brew|cask) "([^"]+)"(?:,.*)?$/);
  if (!match) return undefined;
  return { type: match[1] as "brew" | "cask", name: match[2]! };
}

export async function addPackage(options: {
  readonly cask: boolean;
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly name: string;
  readonly processes: ProcessRunner;
}): Promise<string> {
  validateName(options.name);
  const bundle = join(options.checkoutRoot, "packages/bundle");
  const original = await readFile(bundle, "utf8");
  const type = options.cask ? "cask" : "brew";
  const line = `${type} "${options.name}"`;
  const lines = original.split("\n");
  const existing = lines.map(parsePackageLine).find((entry) => entry?.name === options.name);
  if (existing?.type === type) return `Package '${options.name}' is already declared\n`;
  if (existing) {
    throw new Error(`package '${options.name}' is already declared as ${existing.type}`);
  }

  let inserted = false;
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parsePackageLine(lines[index]!);
    if (parsed?.type === type && options.name.localeCompare(parsed.name) < 0) {
      lines.splice(index, 0, line);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    let last = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (parsePackageLine(lines[index]!)?.type === type) last = index;
    }
    lines.splice(last >= 0 ? last + 1 : lines.length - 1, 0, line);
  }
  await replaceFileAtomic(bundle, lines.join("\n"));

  const argv: [string, ...string[]] = options.cask
    ? ["brew", "install", "--cask", options.name]
    : ["brew", "install", options.name];
  const result = await options.processes.run({
    argv,
    cwd: options.checkoutRoot,
    env: { ...options.env, HOMEBREW_NO_AUTO_UPDATE: "1" },
    output: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `package installation failed; '${options.name}' remains declared for the next dot apply`,
    );
  }
  return `Added and installed ${type} package '${options.name}'\n`;
}

export async function removePackage(options: {
  readonly checkoutRoot: string;
  readonly name: string;
}): Promise<string> {
  validateName(options.name);
  const bundle = join(options.checkoutRoot, "packages/bundle");
  const original = await readFile(bundle, "utf8");
  const lines = original.split("\n");
  const filtered = lines.filter((line) => parsePackageLine(line)?.name !== options.name);
  if (filtered.length === lines.length) return `Package '${options.name}' is not declared\n`;
  await replaceFileAtomic(bundle, filtered.join("\n"));
  return `Removed package '${options.name}' from the Brewfile\n`;
}
