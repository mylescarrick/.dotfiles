import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessRunner } from "./process";

function validateName(name: string): void {
  if (!name || /["\r\n]/.test(name)) throw new Error("invalid package name");
}

async function replaceAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
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
  if (lines.includes(line)) return `Package '${options.name}' is already declared\n`;

  let inserted = false;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(new RegExp(`^${type} "([^"]+)"$`));
    if (match && options.name.localeCompare(match[1]!) < 0) {
      lines.splice(index, 0, line);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    let last = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]!.startsWith(`${type} "`)) last = index;
    }
    lines.splice(last >= 0 ? last + 1 : lines.length - 1, 0, line);
  }
  await replaceAtomic(bundle, lines.join("\n"));

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
  const pattern = new RegExp(`^(brew|cask) "${options.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"$`);
  const lines = original.split("\n");
  const filtered = lines.filter((line) => !pattern.test(line));
  if (filtered.length === lines.length) return `Package '${options.name}' is not declared\n`;
  await replaceAtomic(bundle, filtered.join("\n"));
  return `Removed package '${options.name}' from the Brewfile\n`;
}
