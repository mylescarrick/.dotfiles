import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapMachine } from "../src/bootstrap";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/process";
import type { Terminal } from "../src/terminal";

const temporaryDirectories: string[] = [];

class ScriptedProcesses implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  constructor(private readonly results: ProcessResult[]) {}
  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return this.results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }
}

function terminal(answers: string[] = []): Terminal & { output: string } {
  return {
    interactive: true,
    output: "",
    async prompt() {
      return answers.shift() ?? "";
    },
    write(message) {
      this.output += message;
    },
  };
}

async function home(withOhMyZsh = true): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "dot-bootstrap-"));
  temporaryDirectories.push(path);
  if (withOhMyZsh) await mkdir(join(path, ".oh-my-zsh"));
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("machine bootstrap", () => {
  test("does nothing when required bootstrap tools already exist", async () => {
    const root = await home();
    const processes = new ScriptedProcesses([
      { exitCode: 0, stdout: "brew", stderr: "" },
      { exitCode: 0, stdout: "pi", stderr: "" },
    ]);

    const result = await bootstrapMachine({
      checkoutRoot: join(root, ".dotfiles"),
      env: { HOME: root, PATH: "/bin" },
      processes,
      terminal: terminal(),
    });

    expect(result.stdout).toBe("Homebrew already installed\nPi already installed\noh-my-zsh already installed\n");
    expect(processes.requests.map((request) => request.argv)).toEqual([
      ["brew", "--version"],
      ["pi", "--version"],
    ]);
  });

  test("downloads and verifies missing Homebrew after confirmation", async () => {
    const root = await home();
    const processes = new ScriptedProcesses([
      { exitCode: 127, stdout: "", stderr: "missing" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "brew", stderr: "" },
      { exitCode: 0, stdout: "pi", stderr: "" },
    ]);

    const result = await bootstrapMachine({
      checkoutRoot: join(root, ".dotfiles"),
      env: { HOME: root, PATH: "/bin", DOT_TEST_SECRET: "do-not-share" },
      knownBrewPaths: [],
      processes,
      terminal: terminal(["y"]),
    });

    expect(result.stdout).toContain("Homebrew installed\n");
    expect(processes.requests[1]!.argv.slice(0, 3)).toEqual([
      "curl",
      "-fsSL",
      "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh",
    ]);
    expect(processes.requests[2]!.argv[0]).toBe("/bin/bash");
    expect(processes.requests[2]!.env.NONINTERACTIVE).toBe("1");
    expect(processes.requests[2]!.env.DOT_TEST_SECRET).toBeUndefined();
    expect(processes.requests[3]!.argv).toEqual(["brew", "--version"]);
  });

  test("installs missing Pi as a required tool", async () => {
    const root = await home();
    const processes = new ScriptedProcesses([
      { exitCode: 0, stdout: "brew", stderr: "" },
      { exitCode: 127, stdout: "", stderr: "missing" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "pi", stderr: "" },
    ]);

    const result = await bootstrapMachine({
      checkoutRoot: join(root, ".dotfiles"),
      env: { HOME: root },
      processes,
      terminal: terminal(),
    });

    expect(result.stdout).toContain("Pi installed\n");
    expect(processes.requests[2]!.argv).toEqual([
      "bun",
      "install",
      "-g",
      "@mariozechner/pi-coding-agent",
    ]);
  });

  test("stops when required Pi installation fails", async () => {
    const root = await home();
    const processes = new ScriptedProcesses([
      { exitCode: 0, stdout: "brew", stderr: "" },
      { exitCode: 127, stdout: "", stderr: "missing" },
      { exitCode: 1, stdout: "", stderr: "failed" },
    ]);

    await expect(
      bootstrapMachine({
        checkoutRoot: join(root, ".dotfiles"),
        env: { HOME: root },
        processes,
        terminal: terminal(),
      }),
    ).rejects.toThrow("Pi installation failed");
  });

  test("continues when optional oh-my-zsh installation fails", async () => {
    const root = await home(false);
    const processes = new ScriptedProcesses([
      { exitCode: 0, stdout: "brew", stderr: "" },
      { exitCode: 0, stdout: "pi", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "failed" },
    ]);

    const result = await bootstrapMachine({
      checkoutRoot: join(root, ".dotfiles"),
      env: { HOME: root },
      processes,
      terminal: terminal(["y"]),
    });

    expect(result.stdout).toContain("oh-my-zsh installation failed (continuing)\n");
    expect(processes.requests[2]!.argv.slice(0, 3)).toEqual([
      "curl",
      "-fsSL",
      "https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh",
    ]);
    expect(processes.requests[3]!.argv[0]).toBe("/bin/sh");
  });

  test("treats declined oh-my-zsh installation as optional", async () => {
    const root = await home(false);
    const processes = new ScriptedProcesses([
      { exitCode: 0, stdout: "brew", stderr: "" },
      { exitCode: 0, stdout: "pi", stderr: "" },
    ]);
    const tty = terminal(["n"]);

    const result = await bootstrapMachine({
      checkoutRoot: join(root, ".dotfiles"),
      env: { HOME: root },
      processes,
      terminal: tty,
    });

    expect(result.stdout).toContain("oh-my-zsh skipped\n");
    expect(processes.requests).toHaveLength(2);
  });

  test("refuses noninteractive bootstrap before subprocesses", async () => {
    const root = await home();
    const processes = new ScriptedProcesses([]);
    const noninteractive: Terminal = {
      interactive: false,
      async prompt() {
        throw new Error("unexpected prompt");
      },
      write() {},
    };

    await expect(
      bootstrapMachine({
        checkoutRoot: join(root, ".dotfiles"),
        env: { HOME: root },
        processes,
        terminal: noninteractive,
      }),
    ).rejects.toThrow("dot init requires an interactive terminal");
    expect(processes.requests).toHaveLength(0);
  });
});
