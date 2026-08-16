import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";
import { applyClaudeSettings, planClaudeSettings } from "../src/claude";

const temporaryDirectories: string[] = [];

async function run(argv: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(argv, { cwd, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr}`);
}

async function makeFixture(): Promise<{
  checkout: string;
  env: Record<string, string>;
  home: string;
}> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dot-apply-claude-")));
  temporaryDirectories.push(home);
  const checkout = join(home, ".dotfiles");
  await mkdir(join(checkout, "config/pi"), { recursive: true });
  await mkdir(join(checkout, "packages"), { recursive: true });
  await mkdir(join(checkout, "home/.claude"), { recursive: true });
  await mkdir(join(checkout, "home/.pi/agent"), { recursive: true });
  await writeFile(join(checkout, "packages/bundle"), 'brew "stow"\n');
  await writeFile(join(checkout, "home/.dot-apply-fixture"), "tracked\n");
  await writeFile(
    join(checkout, "config/pi/settings.defaults.json"),
    `${JSON.stringify({ packages: [], theme: "dark" }, null, 2)}\n`
  );
  await writeFile(
    join(checkout, "config/pi/claude-bridge.defaults.json"),
    `${JSON.stringify({ provider: {} }, null, 2)}\n`
  );
  await writeFile(
    join(checkout, "home/.claude/settings.defaults.json"),
    `${JSON.stringify({ outputStyle: "Attention-kind" }, null, 2)}\n`
  );

  await run(["git", "init", "--initial-branch=main"], checkout);
  await run(["git", "config", "user.name", "Dot Tests"], checkout);
  await run(["git", "config", "user.email", "dot@example.test"], checkout);
  await run(["git", "add", "."], checkout);
  await run(["git", "commit", "-m", "fixture"], checkout);
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: checkout }).stdout.toString().trim();
  await run(["git", "update-ref", "refs/remotes/origin/main", head], checkout);

  const fakeBin = join(home, "fake-bin");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "brew"), "#!/bin/sh\nexit 0\n");
  await chmod(join(fakeBin, "brew"), 0o755);
  await writeFile(join(fakeBin, "pi"), "#!/bin/sh\nexit 0\n");
  await chmod(join(fakeBin, "pi"), 0o755);

  return {
    checkout,
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` },
    home,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("dot apply Claude settings", () => {
  test("creates Claude settings with output style default", async () => {
    const fixture = await makeFixture();
    const settingsPath = join(fixture.home, ".claude/settings.json");

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("Claude settings synced");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      outputStyle: "Attention-kind",
    });
    expect((await lstat(settingsPath)).mode & 0o777).toBe(0o600);
  });

  test("merges output style into existing Claude runtime settings", async () => {
    const fixture = await makeFixture();
    const settingsPath = join(fixture.home, ".claude/settings.json");
    await mkdir(join(fixture.home, ".claude"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        enableWorkflows: true,
        hooks: {},
        model: "claude-opus-4",
        theme: "dark",
        tui: "fullscreen",
      })
    );

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("Claude settings synced");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      enableWorkflows: true,
      hooks: {},
      model: "claude-opus-4",
      outputStyle: "Attention-kind",
      theme: "dark",
      tui: "fullscreen",
    });
  });

  test("leaves settings unchanged on second run", async () => {
    const fixture = await makeFixture();
    const app = createApplication({ checkoutRoot: fixture.checkout });

    expect(
      await app.execute({
        argv: ["apply"],
        cwd: fixture.checkout,
        env: fixture.env,
      })
    ).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Claude settings synced"),
    });

    const secondPlan = await planClaudeSettings({
      checkoutRoot: fixture.checkout,
      home: fixture.home,
    });
    expect(secondPlan.changed).toBe(false);
    expect(await applyClaudeSettings(secondPlan)).toBe(false);
  });

  test("runtime value wins over tracked default", async () => {
    const fixture = await makeFixture();
    const settingsPath = join(fixture.home, ".claude/settings.json");
    await mkdir(join(fixture.home, ".claude"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ outputStyle: "Rundown" }));

    await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      outputStyle: "Rundown",
    });
  });
});
