import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceFileAtomic } from "./atomic-file";
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

interface ExternalSkill {
  readonly source?: string;
}

type ExternalSkills = Readonly<Record<string, ExternalSkill>>;

function externalSkillsPath(checkoutRoot: string): string {
  return join(checkoutRoot, "home/.agents/.external-skills.json");
}

async function readExternalSkills(checkoutRoot: string): Promise<ExternalSkills> {
  try {
    const text = await readFile(externalSkillsPath(checkoutRoot), "utf8");
    const parsed = JSON.parse(text) as { readonly skills?: ExternalSkills };
    if (parsed && typeof parsed.skills === "object" && parsed.skills !== null) {
      return parsed.skills;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return {};
}

async function writeExternalSkills(checkoutRoot: string, skills: ExternalSkills): Promise<void> {
  const payload = { version: 1, skills };
  await replaceFileAtomic(externalSkillsPath(checkoutRoot), `${JSON.stringify(payload, null, 2)}\n`);
}

function externalSourcePath(home: string, name: string, entry: ExternalSkill): string {
  return join(home, entry.source ?? `.agents/skills/${name}`);
}

export async function syncSkillLinks(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}): Promise<string> {
  const home = options.env.HOME;
  if (!home) throw new Error("HOME is required");

  const canonical = join(options.checkoutRoot, "home/.agents/skills");
  const agentDirectories = skillAgentDirectories(options.checkoutRoot);
  for (const directory of agentDirectories) {
    await mkdir(directory.path, { recursive: true });
  }

  const names: string[] = [];
  for (const entry of await readdir(canonical, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ignored = await options.processes.run({
      argv: ["git", "-C", options.checkoutRoot, "check-ignore", "-q", `home/.agents/skills/${entry.name}`],
      cwd: options.checkoutRoot,
      env: options.env,
    });
    if (ignored.exitCode === 0) continue;
    names.push(entry.name);
    for (const directory of agentDirectories) {
      await ensureLink(join(directory.path, entry.name), directory.target(entry.name));
    }
  }

  const external = await readExternalSkills(options.checkoutRoot);
  for (const [name, entry] of Object.entries(external)) {
    validateSkillName(name);
    if (!(await exists(externalSourcePath(home, name, entry)))) continue;
    names.push(name);
    for (const directory of agentDirectories) {
      await ensureLink(join(directory.path, name), directory.target(name));
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
  env: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string | undefined>> {
  return {
    ...env,
    BUN_INSTALL_CACHE_DIR: join(sink, "bun"),
    HOME: join(checkoutRoot, "home"),
    XDG_CACHE_HOME: join(sink, "cache"),
    XDG_CONFIG_HOME: join(sink, "config"),
    XDG_DATA_HOME: join(sink, "data"),
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
      argv = ["bunx", "skills@latest", "add", repo!, "-g", "-y", "-s", ...skills, "-a", "pi", "claude-code"];
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
    await rm(sink, { force: true, recursive: true });
  }

  if (options.action === "remove") {
    for (const name of options.args) {
      await rm(join(options.checkoutRoot, "home/.agents/skills", name), {
        force: true,
        recursive: true,
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
  } catch {
    /* no vendored skills lock yet; only local skills exist */
  }
  const external = await readExternalSkills(checkoutRoot);
  const lines = new Map<string, string>();
  for (const entry of (await readdir(canonical, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (!entry.isDirectory()) continue;
    lines.set(entry.name, lock.includes(`"${entry.name}": {`) ? "vendored" : "local");
  }
  for (const name of Object.keys(external).sort((a, b) => a.localeCompare(b))) {
    lines.set(name, "external");
  }
  return lines.size ? `${[...lines.entries()].map(([name, kind]) => `${name}\t${kind}`).join("\n")}\n` : "No skills installed\n";
}

export async function listExternalSkills(checkoutRoot: string): Promise<string> {
  const skills = await readExternalSkills(checkoutRoot);
  const names = Object.keys(skills).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return "No external skills registered\n";
  return `${names.join("\n")}\n`;
}

export async function addExternalSkill(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly name: string;
  readonly processes: ProcessRunner;
  readonly source?: string;
}): Promise<string> {
  validateSkillName(options.name);
  const skills = await readExternalSkills(options.checkoutRoot);
  if (skills[options.name]) {
    throw new Error(`external skill already registered: ${options.name}`);
  }
  await writeExternalSkills(options.checkoutRoot, { ...skills, [options.name]: { source: options.source } });
  return syncSkillLinks({ checkoutRoot: options.checkoutRoot, env: options.env, processes: options.processes });
}

export async function removeExternalSkill(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly name: string;
  readonly processes: ProcessRunner;
}): Promise<string> {
  validateSkillName(options.name);
  const skills = await readExternalSkills(options.checkoutRoot);
  if (!skills[options.name]) {
    throw new Error(`external skill not registered: ${options.name}`);
  }
  const { [options.name]: _, ...rest } = skills;
  await writeExternalSkills(options.checkoutRoot, rest);
  for (const directory of skillAgentDirectories(options.checkoutRoot)) {
    const path = join(directory.path, options.name);
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) await rm(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return syncSkillLinks({ checkoutRoot: options.checkoutRoot, env: options.env, processes: options.processes });
}
