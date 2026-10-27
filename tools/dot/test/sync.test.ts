import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";
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
    expect(outcome.stdout).toContain("Dotfiles stowed\n");
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
