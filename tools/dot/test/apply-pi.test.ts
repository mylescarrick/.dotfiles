import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";
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

async function makeFixture(): Promise<{
  checkout: string;
  env: Record<string, string>;
  home: string;
}> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dot-apply-pi-")));
  temporaryDirectories.push(home);
  const checkout = join(home, ".dotfiles");
  await mkdir(join(checkout, "config/pi"), { recursive: true });
  await mkdir(join(checkout, "packages"), { recursive: true });
  await mkdir(join(checkout, "home"), { recursive: true });
  await writeFile(join(checkout, "packages/bundle"), 'brew "stow"\n');
  await writeFile(join(checkout, "home/.dot-apply-fixture"), "tracked\n");
  await writeFile(
    join(checkout, "config/pi/settings.defaults.json"),
    `${JSON.stringify(
      {
        theme: "dark",
        packages: ["npm:pi-claude-bridge", "npm:@mobrienv/pi-tidy-tools"],
      },
      null,
      2,
    )}\n`,
  );
  await run(["git", "init", "--initial-branch=main"], checkout);
  await run(["git", "config", "user.name", "Dot Tests"], checkout);
  await run(["git", "config", "user.email", "dot@example.test"], checkout);
  await run(["git", "add", "."], checkout);
  await run(["git", "commit", "-m", "fixture"], checkout);
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: checkout })
    .stdout.toString()
    .trim();
  await run(
    ["git", "update-ref", "refs/remotes/origin/main", head],
    checkout,
  );
  const fakeBin = join(home, "fake-bin");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "brew"), "#!/bin/sh\nexit 0\n");
  await chmod(join(fakeBin, "brew"), 0o755);

  return {
    checkout,
    home,
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("dot apply Pi settings", () => {
  test("refuses a checkout behind last-fetched origin before mutation", async () => {
    const fixture = await makeFixture();
    const oldHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: fixture.checkout,
    }).stdout.toString().trim();
    await run(["git", "commit", "--allow-empty", "-m", "remote revision"], fixture.checkout);
    const remoteHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: fixture.checkout,
    }).stdout.toString().trim();
    await run(["git", "update-ref", "refs/remotes/origin/main", remoteHead], fixture.checkout);
    await run(["git", "reset", "--hard", oldHead], fixture.checkout);

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dot: canonical checkout is behind origin/main; run 'dot update'\n",
    });
    expect(await Bun.file(join(fixture.home, ".pi/agent/settings.json")).exists()).toBe(false);
  });

  test("preserves runtime preferences while tracked packages win", async () => {
    const fixture = await makeFixture();
    const settingsPath = join(fixture.home, ".pi/agent/settings.json");
    await mkdir(join(fixture.home, ".pi/agent"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        theme: "custom",
        defaultProvider: "claude-bridge",
        defaultModel: "claude-opus-4-8",
        unknownRuntimeKey: true,
        packages: ["runtime-owned-package"],
      }),
    );

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome).toEqual({
      exitCode: 0,
      stdout:
        "Skill links valid (0)\nPackages already current\nDotfiles stowed\nPi settings synced\n",
      stderr: "",
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      theme: "custom",
      packages: ["npm:pi-claude-bridge", "npm:@mobrienv/pi-tidy-tools"],
      defaultProvider: "claude-bridge",
      defaultModel: "claude-opus-4-8",
      unknownRuntimeKey: true,
    });
    expect((await lstat(settingsPath)).mode & 0o777).toBe(0o600);
  });

  test("creates private settings and leaves an exact rerun untouched", async () => {
    const fixture = await makeFixture();
    const settingsPath = join(fixture.home, ".pi/agent/settings.json");
    const app = createApplication({ checkoutRoot: fixture.checkout });

    expect(
      await app.execute({
        argv: ["apply"],
        cwd: fixture.checkout,
        env: fixture.env,
      }),
    ).toMatchObject({
      exitCode: 0,
      stdout:
        "Skill links valid (0)\nPackages already current\nDotfiles stowed\nPi settings synced\n",
    });
    const first = await lstat(settingsPath);

    expect(
      await app.execute({
        argv: ["apply"],
        cwd: fixture.checkout,
        env: fixture.env,
      }),
    ).toMatchObject({
      exitCode: 0,
      stdout:
        "Skill links valid (0)\nPackages already current\nDotfiles stowed\nPi settings already current\n",
    });
    const second = await lstat(settingsPath);
    expect(second.ino).toBe(first.ino);
    expect(second.mtimeMs).toBe(first.mtimeMs);

    await chmod(settingsPath, 0o644);
    expect(
      await app.execute({
        argv: ["apply"],
        cwd: fixture.checkout,
        env: fixture.env,
      }),
    ).toMatchObject({
      exitCode: 0,
      stdout:
        "Skill links valid (0)\nPackages already current\nDotfiles stowed\nPi settings synced\n",
    });
    expect((await lstat(settingsPath)).mode & 0o777).toBe(0o600);
  });

  test("preserves runtime changes made during an interactive stow decision", async () => {
    const fixture = await makeFixture();
    const settingsPath = join(fixture.home, ".pi/agent/settings.json");
    await mkdir(join(fixture.home, ".pi/agent"), { recursive: true });
    await writeFile(settingsPath, '{"defaultProvider":"before","packages":[]}\n');
    await writeFile(join(fixture.home, ".dot-apply-fixture"), "live conflict\n");
    let prompted = false;
    const terminal: Terminal = {
      interactive: true,
      async prompt() {
        prompted = true;
        await writeFile(
          settingsPath,
          '{"defaultProvider":"changed-during-prompt","packages":[]}\n',
        );
        return "u";
      },
      write() {},
    };

    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      terminal,
    }).execute({ argv: ["apply"], cwd: fixture.checkout, env: fixture.env });

    expect(outcome.exitCode).toBe(0);
    expect(prompted).toBe(true);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
      defaultProvider: "changed-during-prompt",
    });
  });

  test("preserves invalid runtime JSON and fails before replacement", async () => {
    const fixture = await makeFixture();
    const settingsPath = join(fixture.home, ".pi/agent/settings.json");
    await mkdir(join(fixture.home, ".pi/agent"), { recursive: true });
    await writeFile(settingsPath, "{ invalid json\n", { mode: 0o640 });

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dot: Pi runtime settings contains invalid JSON\n",
    });
    expect(await readFile(settingsPath, "utf8")).toBe("{ invalid json\n");
    expect((await lstat(settingsPath)).mode & 0o777).toBe(0o640);
    expect(await Bun.file(join(fixture.home, ".dot-apply-fixture")).exists()).toBe(false);
  });

  test("replaces a dangling legacy symlink with defaults", async () => {
    const fixture = await makeFixture();
    const settingsPath = join(fixture.home, ".pi/agent/settings.json");
    await mkdir(join(fixture.home, ".pi/agent"), { recursive: true });
    await symlink("missing-settings.json", settingsPath);

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome.exitCode).toBe(0);
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(false);
    expect(await Bun.file(join(fixture.home, ".pi/agent/missing-settings.json")).exists()).toBe(false);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
      theme: "dark",
      packages: ["npm:pi-claude-bridge", "npm:@mobrienv/pi-tidy-tools"],
    });
  });

  test("replaces a legacy symlink without changing its tracked target", async () => {
    const fixture = await makeFixture();
    const oldPath = join(fixture.checkout, "old-settings.json");
    const settingsPath = join(fixture.home, ".pi/agent/settings.json");
    const oldBytes = '{"defaultProvider":"github-copilot","packages":["old"]}\n';
    await writeFile(oldPath, oldBytes);
    await run(["git", "add", "old-settings.json"], fixture.checkout);
    await run(["git", "commit", "-m", "old settings"], fixture.checkout);
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: fixture.checkout,
    }).stdout.toString().trim();
    await run(
      ["git", "update-ref", "refs/remotes/origin/main", head],
      fixture.checkout,
    );
    await mkdir(join(fixture.home, ".pi/agent"), { recursive: true });
    await symlink("../../.dotfiles/old-settings.json", settingsPath);

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome.exitCode).toBe(0);
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(false);
    expect(await readFile(oldPath, "utf8")).toBe(oldBytes);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
      defaultProvider: "github-copilot",
      packages: ["npm:pi-claude-bridge", "npm:@mobrienv/pi-tidy-tools"],
    });
  });
});
