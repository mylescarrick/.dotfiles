import { access, lstat, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessRunner } from "./process";
import type { Terminal } from "./terminal";

export interface BootstrapResult {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: string;
}

async function available(options: {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}): Promise<boolean> {
  try {
    const result = await options.processes.run({
      argv: [options.command, "--version"],
      cwd: options.cwd,
      env: options.env,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function confirmed(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

function installerEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const names = [
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TERM",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "BUN_INSTALL",
    "HOMEBREW_PREFIX",
    "NONINTERACTIVE",
    "RUNZSH",
    "CHSH",
    "KEEP_ZSHRC",
    "ZDOTDIR",
  ] as const;
  return Object.fromEntries(
    names.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  );
}

async function installer(options: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly interpreter: "/bin/bash" | "/bin/sh";
  readonly interpreterArgs?: readonly string[];
  readonly processes: ProcessRunner;
  readonly url: string;
}): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "dot-installer-"));
  const path = join(directory, "install.sh");
  try {
    const download = await options.processes.run({
      argv: ["curl", "-fsSL", options.url, "-o", path],
      cwd: options.cwd,
      env: installerEnvironment(options.env),
      output: "inherit",
    });
    if (download.exitCode !== 0) return false;
    const execution = await options.processes.run({
      argv: [options.interpreter, path, ...(options.interpreterArgs ?? [])],
      cwd: options.cwd,
      env: installerEnvironment(options.env),
      output: "inherit",
    });
    return execution.exitCode === 0;
  } catch {
    return false;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function withKnownHomebrew(
  env: Readonly<Record<string, string | undefined>>,
  paths: readonly string[],
): Promise<Readonly<Record<string, string | undefined>> | undefined> {
  for (const path of paths) {
    if (await executable(path)) {
      return { ...env, PATH: `${dirname(path)}:${env.PATH ?? ""}` };
    }
  }
  return undefined;
}

export async function bootstrapMachine(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly knownBrewPaths?: readonly string[];
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
}): Promise<BootstrapResult> {
  if (!options.terminal.interactive) {
    throw new Error("dot init requires an interactive terminal");
  }
  const home = options.env.HOME;
  if (!home) throw new Error("HOME is required");

  let env = options.env;
  const knownBrewPaths = options.knownBrewPaths ?? [
    ...(env.HOMEBREW_PREFIX ? [join(env.HOMEBREW_PREFIX, "bin/brew")] : []),
    "/opt/homebrew/bin/brew",
    "/usr/local/bin/brew",
  ];
  const lines: string[] = [];
  let brewAvailable = await available({
    command: "brew",
    cwd: options.checkoutRoot,
    env,
    processes: options.processes,
  });
  if (!brewAvailable) {
    const known = await withKnownHomebrew(env, knownBrewPaths);
    if (known) {
      env = known;
      brewAvailable = true;
    }
  }

  if (brewAvailable) {
    lines.push("Homebrew already installed");
  } else {
    const answer = await options.terminal.prompt(
      "Homebrew is missing. Install it from the official installer? [y/N]: ",
    );
    if (!confirmed(answer)) throw new Error("Homebrew installation declined");
    const installed = await installer({
      cwd: options.checkoutRoot,
      env: { ...env, NONINTERACTIVE: "1" },
      interpreter: "/bin/bash",
      processes: options.processes,
      url: "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh",
    });
    if (!installed) throw new Error("Homebrew installer failed");

    if (
      !(await available({
        command: "brew",
        cwd: options.checkoutRoot,
        env,
        processes: options.processes,
      }))
    ) {
      const known = await withKnownHomebrew(env, knownBrewPaths);
      if (!known) throw new Error("Homebrew installer completed but brew was not found");
      env = known;
    }
    lines.push("Homebrew installed");
  }

  if (
    await available({
      command: "pi",
      cwd: options.checkoutRoot,
      env,
      processes: options.processes,
    })
  ) {
    lines.push("Pi already installed");
  } else {
    const install = await options.processes.run({
      argv: ["bun", "install", "-g", "@mariozechner/pi-coding-agent"],
      cwd: options.checkoutRoot,
      env,
      output: "inherit",
    });
    if (install.exitCode !== 0) throw new Error("Pi installation failed");
    if (
      !(await available({
        command: "pi",
        cwd: options.checkoutRoot,
        env,
        processes: options.processes,
      }))
    ) {
      throw new Error("Pi installation completed but pi was not found");
    }
    lines.push("Pi installed");
  }

  try {
    if ((await lstat(join(home, ".oh-my-zsh"))).isDirectory()) {
      lines.push("oh-my-zsh already installed");
      return { env, stdout: `${lines.join("\n")}\n` };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const answer = await options.terminal.prompt(
    "oh-my-zsh is missing. Install it from the official installer? [y/N]: ",
  );
  if (!confirmed(answer)) {
    lines.push("oh-my-zsh skipped");
    return { env, stdout: `${lines.join("\n")}\n` };
  }
  const installed = await installer({
    cwd: options.checkoutRoot,
    env: { ...env, RUNZSH: "no", CHSH: "no", KEEP_ZSHRC: "yes" },
    interpreter: "/bin/sh",
    interpreterArgs: ["--unattended"],
    processes: options.processes,
    url: "https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh",
  });
  lines.push(installed ? "oh-my-zsh installed" : "oh-my-zsh installation failed (continuing)");
  return { env, stdout: `${lines.join("\n")}\n` };
}
