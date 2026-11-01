import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";
import { bunProcessRunner, type ProcessRunner } from "../src/process";
import type { Terminal } from "../src/terminal";

const temporaryDirectories: string[] = [];
const quiet: Terminal = { interactive: false, prompt: () => Promise.resolve(""), write: () => undefined };

function run(argv: string[], cwd: string): string {
  const result = Bun.spawnSync(argv, { cwd });
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function makeFixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dot-sync-")));
  temporaryDirectories.push(home);
  const checkout = join(home, ".dotfiles");
  await mkdir(join(checkout, "config/pi"), { recursive: true });
  await mkdir(join(checkout, "packages"), { recursive: true });
  await mkdir(join(checkout, "home/.pi/agent"), { recursive: true });
  await writeFile(join(checkout, "packages/bundle"), 'brew "stow"\n');
  await writeFile(join(checkout, "home/.dot-sync-fixture"), "tracked\n");
  await writeFile(join(checkout, "config/pi/settings.defaults.json"), '{"packages":[]}\n');

  run(["git", "init", "--initial-branch=main"], checkout);
  run(["git", "config", "user.name", "Dot Tests"], checkout);
  run(["git", "config", "user.email", "dot@example.test"], checkout);
  run(["git", "add", "."], checkout);
  run(["git", "commit", "-m", "fixture"], checkout);
  run(
    ["git", "update-ref", "refs/remotes/origin/main", run(["git", "rev-parse", "HEAD"], checkout)],
    checkout
  );

  const fakeBin = join(home, "fake-bin");
  await mkdir(fakeBin);
  for (const name of ["brew", "pi"]) {
    await writeFile(join(fakeBin, name), "#!/bin/sh\nexit 0\n");
    await chmod(join(fakeBin, name), 0o755);
  }
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".state"),
  };
  return { checkout, env, home };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("bare dot", () => {
  test("applies, then reports drift without starting the agent when not interactive", async () => {
    const { checkout, env, home } = await makeFixture();
    await mkdir(join(home, ".agents/skills/handmade"), { recursive: true });
    await writeFile(join(home, ".agents/skills/handmade/SKILL.md"), "# Handmade\n");

    const outcome = await createApplication({ checkoutRoot: checkout, terminal: quiet }).execute({
      argv: [],
      cwd: checkout,
      env,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain(
      "Dotfiles deployed (1 installed, 0 updated, 0 link(s) replaced, 0 removed)\n"
    );
    expect(outcome.stdout).toContain("1 skill drift item(s); run 'dot reconcile'\n");
    expect(outcome.stdout).toContain("1 drift item(s); run 'dot reconcile' in a terminal:\n");
    expect(outcome.stdout).toContain("handmade  new skill on this Mac, not in the repo");
  });

  test("reports no drift on a machine that matches the checkout", async () => {
    const { checkout, env } = await makeFixture();

    const outcome = await createApplication({ checkoutRoot: checkout, terminal: quiet }).execute({
      argv: [],
      cwd: checkout,
      env,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toEndWith("No drift to reconcile\n");
  });

  test("applies nothing from a noncanonical checkout", async () => {
    const { checkout, env, home } = await makeFixture();
    const other = join(home, "worktree");
    run(["git", "worktree", "add", "-b", "feature", other], checkout);

    const outcome = await createApplication({ checkoutRoot: other, terminal: quiet }).execute({
      argv: [],
      cwd: other,
      env,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain("FAILED checkout validation");
  });
});

describe("bare dot update offer", () => {
  async function withReport(home: string, env: Record<string, string | undefined>) {
    const dir = join(env.XDG_STATE_HOME as string, "dot");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "outdated.json"),
      JSON.stringify({
        brew: [{ installed: "1.0", latest: "2.0", name: "zoom" }],
        bun: [],
        checkedAt: new Date().toISOString(),
        errors: [],
        pi: [],
      })
    );
    expect(home).toBeTruthy();
  }

  function recording(calls: string[]): ProcessRunner {
    return {
      run(request) {
        const [command, ...rest] = request.argv;
        // Real upgrades must never run from a test.
        if (["brew", "bun", "pi"].includes(command as string) && rest[0] !== "--version") {
          calls.push(request.argv.join(" "));
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: command === "brew" ? "{}" : "" });
        }
        return bunProcessRunner.run(request);
      },
    };
  }

  function asking(answers: string[], prompts: string[]): Terminal {
    return {
      interactive: true,
      prompt: (message) => {
        prompts.push(message);
        return Promise.resolve(answers.shift() ?? "");
      },
      write: () => undefined,
    };
  }

  test("lists what is outdated, asks once, and does not ask again within a week", async () => {
    const { checkout, env, home } = await makeFixture();
    await withReport(home, env);
    const prompts: string[] = [];
    const calls: string[] = [];
    const app = (answers: string[]) =>
      createApplication({
        checkoutRoot: checkout,
        processes: recording(calls),
        terminal: asking(answers, prompts),
      });

    const first = await app(["n"]).execute({ argv: [], cwd: checkout, env });
    const second = await app([]).execute({ argv: [], cwd: checkout, env });

    expect(prompts[0]).toContain("zoom  1.0 -> 2.0");
    expect(first.stdout).toContain("Not upgrading now.");
    expect(prompts.filter((message) => message.includes("Upgrade these now?"))).toHaveLength(1);
    expect(second.stdout).toContain("zoom  1.0 -> 2.0");
    expect(second.stdout).toContain("Run 'dot upgrade' to install them.");
    expect(calls.some((call) => call.startsWith("brew upgrade"))).toBe(false);
  });

  test("upgrades Homebrew, Bun and Pi after one yes, then refreshes the list", async () => {
    const { checkout, env, home } = await makeFixture();
    await withReport(home, env);
    const calls: string[] = [];
    const prompts: string[] = [];

    const outcome = await createApplication({
      checkoutRoot: checkout,
      processes: recording(calls),
      terminal: asking(["y"], prompts),
    }).execute({ argv: [], cwd: checkout, env });

    expect(outcome.exitCode).toBe(0);
    expect(calls).toContain("brew upgrade");
    expect(calls).toContain("bun upgrade");
    expect(calls).toContain("pi update --all");
    expect(prompts.filter((message) => message.includes("Upgrade Homebrew"))).toHaveLength(0);
  });
});
