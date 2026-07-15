import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
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
  await writeFile(
    join(checkout, "config/pi/settings.defaults.json"),
    '{"theme":"dark","packages":[]}\n',
  );
  await writeFile(join(checkout, "packages/bundle"), 'brew "stow"\n');
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
    home,
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` },
  };
}

const interactive: Terminal = {
  interactive: true,
  async prompt() {
    throw new Error("unexpected prompt");
  },
  write() {},
};

class FreshBootstrapProcesses implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  private brewInstalled = false;
  private piInstalled = false;

  constructor(private readonly failPiInstall = false) {}

  async run(request: ProcessRequest) {
    this.requests.push(request);
    const [command, ...args] = request.argv;
    if (command === "brew" && args[0] === "--version") {
      return {
        exitCode: this.brewInstalled ? 0 : 127,
        stdout: "",
        stderr: "",
      };
    }
    if (command === "curl") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "/bin/bash") {
      this.brewInstalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "pi" && args[0] === "--version") {
      return {
        exitCode: this.piInstalled ? 0 : 127,
        stdout: "",
        stderr: "",
      };
    }
    if (
      command === "bun" &&
      args.join(" ") === "install -g @mariozechner/pi-coding-agent"
    ) {
      if (this.failPiInstall) return { exitCode: 1, stdout: "", stderr: "failed" };
      this.piInstalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "/bin/sh") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "brew" && args[0] === "bundle") {
      return { exitCode: 0, stdout: "", stderr: "" };
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
    write() {},
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
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
    expect(outcome.stdout).toContain("Homebrew already installed\nPi already installed\n");
    expect(outcome.stdout).toContain("Packages already current\nDotfiles stowed\n");
    expect(outcome.stdout).toContain("OK    checkout:");
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
    expect(outcome.stdout).toContain("Homebrew installed\nPi installed\n");
    expect(outcome.stdout).toContain("oh-my-zsh installed\n");
    expect(outcome.stdout).toContain("Dotfiles stowed\n");
    expect(outcome.stdout).toContain("0 actionable issues\n");
  });

  test("required bootstrap failure prevents apply and doctor mutation", async () => {
    const state = await fixture();
    const processes = new FreshBootstrapProcesses(true);
    const outcome = await createApplication({
      checkoutRoot: state.checkout,
      processes,
      terminal: answeringTerminal(["y"]),
    }).execute({ argv: ["init"], cwd: state.checkout, env: state.env });

    expect(outcome).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dot: Pi installation failed\n",
    });
    expect(await Bun.file(join(state.home, ".managed")).exists()).toBe(false);
    expect(await Bun.file(join(state.home, ".pi/agent/settings.json")).exists()).toBe(false);
    expect(
      processes.requests.some(({ argv }) => argv[0] === "stow"),
    ).toBe(false);
  });

  test("rejects init options before bootstrap", async () => {
    const outcome = await createApplication({ checkoutRoot: "/missing" }).execute({
      argv: ["init", "--yes"],
      cwd: "/missing",
      env: {},
    });
    expect(outcome).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "dot: usage: dot init\n",
    });
  });

  test("refuses noninteractive init before mutation", async () => {
    const outcome = await createApplication({ checkoutRoot: "/missing" }).execute({
      argv: ["init"],
      cwd: "/missing",
      env: { HOME: "/tmp/home" },
    });
    expect(outcome).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dot: dot init requires an interactive terminal\n",
    });
  });
});
