import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";
import { bunProcessRunner, type ProcessRequest, type ProcessRunner } from "../src/process";
import type { Terminal } from "../src/terminal";

const temporaryDirectories: string[] = [];

async function run(argv: string[], cwd: string): Promise<string> {
  const result = Bun.spawnSync(argv, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function fixture(): Promise<{
  checkout: string;
  env: Record<string, string>;
  home: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "dot-init-"));
  temporaryDirectories.push(home);
  const checkout = join(home, ".dotfiles");
  await mkdir(join(checkout, "config/pi"), { recursive: true });
  await mkdir(join(checkout, "packages"), { recursive: true });
  await mkdir(join(checkout, "home"), { recursive: true });
  await mkdir(join(home, ".oh-my-zsh"));
  await writeFile(join(checkout, "config/pi/settings.defaults.json"), '{"theme":"dark","packages":[]}\n');
  await writeFile(
    join(checkout, "config/pi/claude-bridge.defaults.json"),
    '{"provider":{"pathToClaudeCodeExecutable":"/opt/homebrew/bin/claude"}}\n'
  );
  await writeFile(join(checkout, "packages/bundle"), 'brew "stow"\n');
  await writeFile(
    join(checkout, "packages/bun-global"),
    "@earendil-works/pi-coding-agent@0.84.1\nfrog@1.1.0\n"
  );
  await writeFile(join(checkout, "home/.managed"), "tracked\n");
  await run(["git", "init", "--initial-branch=main"], checkout);
  await run(["git", "config", "user.name", "Dot Tests"], checkout);
  await run(["git", "config", "user.email", "dot@example.test"], checkout);
  await run(["git", "add", "."], checkout);
  await run(["git", "commit", "-m", "fixture"], checkout);
  const head = await run(["git", "rev-parse", "HEAD"], checkout);
  await run(["git", "update-ref", "refs/remotes/origin/main", head], checkout);

  const fakeBin = join(home, "fake-bin");
  await mkdir(fakeBin);
  for (const tool of ["brew", "pi"]) {
    await writeFile(join(fakeBin, tool), "#!/bin/sh\nexit 0\n");
    await chmod(join(fakeBin, tool), 0o755);
  }
  return {
    checkout,
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` },
    home,
  };
}

const interactive: Terminal = {
  interactive: true,
  async prompt() {
    throw new Error("unexpected prompt");
  },
  write() {
    // test helper does not capture output
  },
};

class FreshBootstrapProcesses implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  private brewInstalled = false;
  private readonly installed = new Map<string, boolean>([
    ["pi", false],
    ["frog", false],
  ]);

  constructor(private readonly failBrewInstall = false) {}

  private isBrewInstalled(): boolean {
    return this.brewInstalled;
  }

  async run(request: ProcessRequest) {
    this.requests.push(request);
    const [command, ...args] = request.argv;
    if (command === "brew" && args[0] === "--version") {
      return {
        exitCode: this.isBrewInstalled() ? 0 : 127,
        stderr: "",
        stdout: "",
      };
    }
    if (command === "curl") {
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    if (command === "/bin/bash") {
      if (this.failBrewInstall) return { exitCode: 1, stderr: "failed", stdout: "" };
      this.brewInstalled = true;
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    if ((command === "pi" || command === "frog") && args[0] === "--version") {
      return {
        exitCode: this.installed.get(command) ? 0 : 127,
        stderr: "",
        stdout: "",
      };
    }
    if (command === "bun" && args[0] === "pm" && args[1] === "ls" && args[2] === "-g") {
      const lines: string[] = ["/Users/test/.bun/install/global node_modules"];
      if (this.installed.get("pi")) lines.push("├── @earendil-works/pi-coding-agent@0.84.1");
      if (this.installed.get("frog")) lines.push(`${this.installed.get("pi") ? "├──" : "└──"} frog@1.1.0`);
      if (lines.length === 1) lines[0] += " (0)";
      return { exitCode: 0, stderr: "", stdout: `${lines.join("\n")}\n` };
    }
    if (command === "bun" && args[0] === "add" && args[1] === "-g") {
      for (const spec of args.slice(2)) {
        if (
          spec.startsWith("@earendil-works/pi-coding-agent") ||
          spec.startsWith("@mariozechner/pi-coding-agent")
        ) {
          this.installed.set("pi", true);
        } else if (spec === "frog" || spec.startsWith("frog@")) {
          this.installed.set("frog", true);
        }
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    if (command === "/bin/sh") {
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    if (command === "brew" && args[0] === "bundle") {
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    return bunProcessRunner.run(request);
  }
}

function answeringTerminal(answers: string[]): Terminal {
  return {
    interactive: true,
    async prompt() {
      return answers.shift() ?? "";
    },
    write() {
      // test helper does not capture output
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("dot init", () => {
  test("bootstraps, applies declared state, and finishes with doctor", async () => {
    const state = await fixture();
    const outcome = await createApplication({
      checkoutRoot: state.checkout,
      terminal: interactive,
    }).execute({ argv: ["init"], cwd: state.checkout, env: state.env });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe("");
    expect(outcome.stdout).toContain("Homebrew already installed\noh-my-zsh already installed\n");
    expect(outcome.stdout).toContain(
      "Packages already current\nGlobal Bun packages already current\nDotfiles stowed\n"
    );
    expect(outcome.stdout).toContain("OK    checkout:");
    expect(outcome.stdout).toContain("OK    bun-global:");
    expect(outcome.stdout).toContain("0 actionable issues\n");
  });

  test("threads fresh Homebrew and Pi bootstrap into apply and doctor", async () => {
    const state = await fixture();
    await rm(join(state.home, ".oh-my-zsh"), { recursive: true });
    const processes = new FreshBootstrapProcesses();
    const outcome = await createApplication({
      checkoutRoot: state.checkout,
      knownBrewPaths: [],
      processes,
      terminal: answeringTerminal(["y", "y"]),
    }).execute({ argv: ["init"], cwd: state.checkout, env: state.env });

    expect(outcome).toMatchObject({ exitCode: 0, stderr: "" });
    expect(outcome.stdout).toContain("Homebrew installed\noh-my-zsh installed\n");
    expect(outcome.stdout).toContain("Installed 2 global Bun package(s)\n");
    expect(outcome.stdout).toContain("Dotfiles stowed\n");
    expect(outcome.stdout).toContain("0 actionable issues\n");
  });

  test("refuses noncanonical init before system bootstrap", async () => {
    const state = await fixture();
    const worktree = join(state.home, "feature-init");
    await run(["git", "worktree", "add", "-b", "feature-init", worktree], state.checkout);
    const processes = new FreshBootstrapProcesses();

    const outcome = await createApplication({
      checkoutRoot: worktree,
      processes,
      terminal: answeringTerminal(["y", "y"]),
    }).execute({ argv: ["init"], cwd: worktree, env: state.env });

    expect(outcome).toEqual({
      exitCode: 1,
      stderr: `dot: machine mutation must run from the canonical checkout at ${state.checkout}\n`,
      stdout: "",
    });
    expect(
      processes.requests.some(({ argv }) => ["brew", "pi", "curl", "bun", "stow"].includes(argv[0]))
    ).toBe(false);
  });

  test("required bootstrap failure prevents apply and doctor mutation", async () => {
    const state = await fixture();
    const processes = new FreshBootstrapProcesses(true);
    const outcome = await createApplication({
      checkoutRoot: state.checkout,
      knownBrewPaths: [],
      processes,
      terminal: answeringTerminal(["y"]),
    }).execute({ argv: ["init"], cwd: state.checkout, env: state.env });

    expect(outcome).toEqual({
      exitCode: 1,
      stderr: "dot: Homebrew installer failed\n",
      stdout: "",
    });
    expect(await Bun.file(join(state.home, ".managed")).exists()).toBe(false);
    expect(await Bun.file(join(state.home, ".pi/agent/settings.json")).exists()).toBe(false);
    expect(processes.requests.some(({ argv }) => argv[0] === "stow")).toBe(false);
  });

  test("rejects init options before bootstrap", async () => {
    const outcome = await createApplication({ checkoutRoot: "/missing" }).execute({
      argv: ["init", "--yes"],
      cwd: "/missing",
      env: {},
    });
    expect(outcome).toEqual({
      exitCode: 2,
      stderr: "dot: usage: dot init\n",
      stdout: "",
    });
  });

  test("refuses noninteractive init before mutation", async () => {
    const state = await fixture();
    const outcome = await createApplication({ checkoutRoot: state.checkout }).execute({
      argv: ["init"],
      cwd: state.checkout,
      env: state.env,
    });
    expect(outcome).toEqual({
      exitCode: 1,
      stderr: "dot: dot init requires an interactive terminal\n",
      stdout: "",
    });
  });
});
