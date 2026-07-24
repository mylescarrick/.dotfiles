import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";
import { bunProcessRunner, type ProcessRequest, type ProcessResult, type ProcessRunner } from "../src/process";
import type { Terminal } from "../src/terminal";

const temporaryDirectories: string[] = [];

async function run(argv: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr}`);
}

async function makeFixture(): Promise<{ checkout: string; env: Record<string, string> }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dot-skills-workflow-")));
  temporaryDirectories.push(home);
  const checkout = join(home, ".dotfiles");
  const origin = await mkdtemp(join(tmpdir(), "dot-skills-workflow-origin-"));
  temporaryDirectories.push(origin);

  await mkdir(join(checkout, "home/.agents/skills/example"), { recursive: true });
  await writeFile(join(checkout, "home/.agents/skills/example/SKILL.md"), "# example\n");
  await mkdir(join(checkout, "home/.pi/agent/skills"), { recursive: true });
  await mkdir(join(checkout, "home/.claude/skills"), { recursive: true });
  await symlink("../../../.agents/skills/example", join(checkout, "home/.pi/agent/skills/example"));
  await symlink("../../.agents/skills/example", join(checkout, "home/.claude/skills/example"));

  await run(["git", "init", "--bare", "--initial-branch=main"], origin);
  await run(["git", "init", "--initial-branch=main"], checkout);
  await run(["git", "config", "user.name", "Dot Tests"], checkout);
  await run(["git", "config", "user.email", "dot@example.test"], checkout);
  await run(["git", "remote", "add", "origin", origin], checkout);
  await run(["git", "add", "."], checkout);
  await run(["git", "commit", "-m", "fixture"], checkout);
  await run(["git", "push", "-u", "origin", "main"], checkout);

  return { checkout, env: { HOME: home, PATH: process.env.PATH ?? "" } };
}

class ScriptedProcesses implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  constructor(
    private readonly overrides: (
      request: ProcessRequest,
    ) => Promise<ProcessResult | undefined> | ProcessResult | undefined = () => undefined,
  ) {}
  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    const overridden = await this.overrides(request);
    if (overridden) return overridden;
    return bunProcessRunner.run(request);
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("skills workflow", () => {
  test("refuses noninteractive mutation of the canonical checkout on main without --yes", async () => {
    const fixture = await makeFixture();
    const processes = new ScriptedProcesses();
    const terminal: Terminal = {
      interactive: false,
      async prompt() {
        throw new Error("unexpected prompt");
      },
      write() {},
    };

    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      processes,
      terminal,
    }).execute({ argv: ["skills", "update"], cwd: fixture.checkout, env: fixture.env });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("must not run directly against the canonical checkout on main");
    expect(processes.requests.some((request) => request.argv[0] === "bunx")).toBe(false);
    expect(processes.requests.some((request) => request.argv.includes("worktree"))).toBe(false);
  });

  test("prompts, and aborts without touching the checkout when declined", async () => {
    const fixture = await makeFixture();
    const processes = new ScriptedProcesses();
    const prompts: string[] = [];
    const terminal: Terminal = {
      interactive: true,
      async prompt(message) {
        prompts.push(message);
        return "n";
      },
      write() {},
    };

    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      processes,
      terminal,
    }).execute({ argv: ["skills", "update"], cwd: fixture.checkout, env: fixture.env });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("aborted");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Create a worktree");
    expect(processes.requests.some((request) => request.argv.includes("worktree"))).toBe(false);
  });

  test("on confirmation, vendors into a worktree, commits, pushes, and opens a PR", async () => {
    const fixture = await makeFixture();
    let openedPr: ProcessRequest | undefined;
    const processes = new ScriptedProcesses((request) => {
      if (request.argv[0] === "bunx") {
        return (async () => {
          await mkdir(join(request.cwd, "home/.agents/skills/example/agents"), {
            recursive: true,
          });
          await writeFile(
            join(request.cwd, "home/.agents/skills/example/agents/openai.yaml"),
            "display_name: Example\n",
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        })();
      }
      if (request.argv[0] === "gh") {
        openedPr = request;
        return { exitCode: 0, stdout: "https://github.com/example/example/pull/1\n", stderr: "" };
      }
      return undefined;
    });
    const terminal: Terminal = {
      interactive: true,
      async prompt() {
        return "y";
      },
      write() {},
    };

    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      processes,
      terminal,
    }).execute({
      argv: ["skills", "update"],
      cwd: fixture.checkout,
      env: { ...fixture.env, now: undefined as unknown as string },
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("chore(skills): update vendored skills");
    expect(outcome.stdout).toContain("Worktree:");
    expect(outcome.stdout).toContain("https://github.com/example/example/pull/1");

    expect(openedPr).toBeDefined();
    expect(openedPr!.argv).toEqual([
      "gh",
      "pr",
      "create",
      "--title",
      "chore(skills): update vendored skills",
      "--body",
      expect.stringContaining("Refreshed vendored skills") as unknown as string,
      "--head",
      expect.stringMatching(/^chore\/skills-update-/) as unknown as string,
      "--base",
      "main",
    ]);

    const worktrees = Bun.spawnSync(["git", "-C", fixture.checkout, "worktree", "list"])
      .stdout.toString();
    expect(worktrees).toContain("skills-update-");

    const log = Bun.spawnSync(
      ["git", "log", "--oneline", "-1", openedPr!.argv[8] as string],
      { cwd: fixture.checkout },
    ).stdout.toString();
    expect(log).toContain("chore(skills): update vendored skills");
  });

  test("removes the worktree and skips the PR when there is nothing to commit", async () => {
    const fixture = await makeFixture();
    const processes = new ScriptedProcesses((request) => {
      if (request.argv[0] === "bunx") return { exitCode: 0, stdout: "", stderr: "" };
      if (request.argv[0] === "gh") throw new Error("unexpected gh call");
      return undefined;
    });
    const terminal: Terminal = {
      interactive: true,
      async prompt() {
        return "y";
      },
      write() {},
    };

    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      processes,
      terminal,
    }).execute({ argv: ["skills", "update"], cwd: fixture.checkout, env: fixture.env });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("Nothing to commit; removed worktree");

    const worktrees = Bun.spawnSync(["git", "-C", fixture.checkout, "worktree", "list"])
      .stdout.toString();
    expect(worktrees).not.toContain("skills-update-");
  });

  test("--yes skips the prompt entirely", async () => {
    const fixture = await makeFixture();
    const processes = new ScriptedProcesses((request) => {
      if (request.argv[0] === "bunx") return { exitCode: 0, stdout: "", stderr: "" };
      if (request.argv[0] === "gh") return { exitCode: 0, stdout: "url\n", stderr: "" };
      return undefined;
    });
    const terminal: Terminal = {
      interactive: true,
      async prompt() {
        throw new Error("unexpected prompt");
      },
      write() {},
    };

    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      processes,
      terminal,
    }).execute({ argv: ["skills", "update", "--yes"], cwd: fixture.checkout, env: fixture.env });

    expect(outcome.exitCode).toBe(0);
  });

  test("runs directly, without guarding, when not on the canonical checkout's main branch", async () => {
    const fixture = await makeFixture();
    await run(["git", "checkout", "-b", "feature"], fixture.checkout);
    const processes = new ScriptedProcesses((request) => {
      if (request.argv[0] === "bunx") return { exitCode: 0, stdout: "", stderr: "" };
      return undefined;
    });
    const terminal: Terminal = {
      interactive: true,
      async prompt() {
        throw new Error("unexpected prompt");
      },
      write() {},
    };

    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      processes,
      terminal,
    }).execute({ argv: ["skills", "update"], cwd: fixture.checkout, env: fixture.env });

    expect(outcome.exitCode).toBe(0);
    expect(processes.requests.some((request) => request.argv.includes("worktree"))).toBe(false);
    expect(processes.requests.some((request) => request.argv[0] === "bunx")).toBe(true);
  });
});
