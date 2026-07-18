import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessRunner } from "./process";
import { skillAgentDirectories } from "./skill-layout";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureLink(path: string, target: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isSymbolicLink()) {
      throw new Error(`cannot replace non-symlink skill path: ${path}`);
    }
    if ((await readlink(path)) === target) return;
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(target, path);
}

export async function syncSkillLinks(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}): Promise<string> {
  const canonical = join(options.checkoutRoot, "home/.agents/skills");
  const agentDirectories = skillAgentDirectories(options.checkoutRoot);
  for (const directory of agentDirectories) {
    await mkdir(directory.path, { recursive: true });
  }

  const names: string[] = [];
  for (const entry of await readdir(canonical, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ignored = await options.processes.run({
      argv: [
        "git",
        "-C",
        options.checkoutRoot,
        "check-ignore",
        "-q",
        `home/.agents/skills/${entry.name}`,
      ],
      cwd: options.checkoutRoot,
      env: options.env,
    });
    if (ignored.exitCode === 0) continue;
    names.push(entry.name);
    for (const directory of agentDirectories) {
      await ensureLink(join(directory.path, entry.name), directory.target(entry.name));
    }
  }

  let pruned = 0;
  for (const directory of agentDirectories) {
    for (const entry of await readdir(directory.path, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      const path = join(directory.path, entry.name);
      if (!(await exists(path))) {
        await rm(path);
        pruned += 1;
      }
    }
  }
  return `Synced ${names.length} skill(s); pruned ${pruned} dangling link(s)\n`;
}

function validateSkillName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name === "." || name === "..") {
    throw new Error(`invalid skill name: ${name}`);
  }
}

function scopedEnvironment(
  checkoutRoot: string,
  sink: string,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return {
    ...env,
    HOME: join(checkoutRoot, "home"),
    XDG_CONFIG_HOME: join(sink, "config"),
    XDG_CACHE_HOME: join(sink, "cache"),
    XDG_DATA_HOME: join(sink, "data"),
    BUN_INSTALL_CACHE_DIR: join(sink, "bun"),
  };
}

export async function runSkillsCli(options: {
  readonly action: "add" | "update" | "remove";
  readonly args: readonly string[];
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}): Promise<string> {
  const skillNames = options.action === "add" ? options.args.slice(1) : options.args;
  for (const name of skillNames) validateSkillName(name);

  const sink = await mkdtemp(join(tmpdir(), "dot-skills-"));
  try {
    let argv: [string, ...string[]];
    if (options.action === "add") {
      const [repo, ...skills] = options.args;
      argv = [
        "bunx",
        "skills@latest",
        "add",
        repo!,
        "-g",
        "-y",
        "-s",
        ...skills,
        "-a",
        "pi",
        "claude-code",
      ];
    } else if (options.action === "update") {
      argv = ["bunx", "skills@latest", "update", "-g", "-y"];
    } else {
      argv = [
        "bunx",
        "skills@latest",
        "remove",
        "-g",
        "-y",
        "-a",
        "pi",
        "claude-code",
        "-s",
        ...options.args,
      ];
    }
    const result = await options.processes.run({
      argv,
      cwd: options.checkoutRoot,
      env: scopedEnvironment(options.checkoutRoot, sink, options.env),
      output: "inherit",
    });
    if (result.exitCode !== 0 && options.action !== "remove") {
      throw new Error(`skills ${options.action} failed`);
    }
  } finally {
    await rm(sink, { recursive: true, force: true });
  }

  if (options.action === "remove") {
    for (const name of options.args) {
      await rm(join(options.checkoutRoot, "home/.agents/skills", name), {
        recursive: true,
        force: true,
      });
    }
  }
  return syncSkillLinks(options);
}

export async function listSkills(checkoutRoot: string): Promise<string> {
  const canonical = join(checkoutRoot, "home/.agents/skills");
  const lockPath = join(checkoutRoot, "home/.agents/.skill-lock.json");
  let lock = "";
  try {
    lock = await readFile(lockPath, "utf8");
  } catch {}
  const lines: string[] = [];
  for (const entry of (await readdir(canonical, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    lines.push(`${entry.name}\t${lock.includes(`"${entry.name}": {`) ? "vendored" : "local"}`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "No skills installed\n";
}
