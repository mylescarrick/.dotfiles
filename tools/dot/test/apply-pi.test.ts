import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";
import { bunProcessRunner, type ProcessRequest, type ProcessRunner } from "../src/process";
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
  await writeFile(join(fakeBin, "pi"), "#!/bin/sh\nexit 0\n");
  await chmod(join(fakeBin, "pi"), 0o755);

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

class RecordingDelegate implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  async run(request: ProcessRequest) {
    this.requests.push(request);
    return bunProcessRunner.run(request);
  }
}

class FailingCommandDelegate implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  constructor(private readonly failure: readonly string[]) {}
  async run(request: ProcessRequest) {
    this.requests.push(request);
    if (request.argv.join("\0") === this.failure.join("\0")) {
      return { exitCode: 1, stdout: "", stderr: "failed" };
    }
    return bunProcessRunner.run(request);
  }
}

describe("dot apply Pi settings", () => {
  test("upgrade applies state before upgrading Homebrew and Pi", async () => {
    const fixture = await makeFixture();
    const processes = new RecordingDelegate();
    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      processes,
    }).execute({
      argv: ["upgrade", "--yes"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome.exitCode).toBe(0);
    const upgrades = processes.requests
      .map((request) => request.argv)
      .filter((argv) => argv[0] === "brew" || argv[0] === "pi");
    expect(upgrades).toEqual([
      [
        "brew",
        "bundle",
        "check",
        "--no-upgrade",
        "--file",
        join(fixture.checkout, "packages/bundle"),
      ],
      ["brew", "update"],
      ["brew", "upgrade"],
      ["pi", "update", "--all"],
    ]);
  });

  test("reports completed apply stages when Homebrew upgrade fails", async () => {
    const fixture = await makeFixture();
    const processes = new FailingCommandDelegate(["brew", "upgrade"]);

    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      processes,
    }).execute({
      argv: ["upgrade", "--yes"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain("Dotfiles stowed\n");
    expect(outcome.stdout).toEndWith(
      "FAILED Homebrew package upgrade: Homebrew package upgrade failed\n",
    );
    expect(outcome.stderr).toBe("dot: Homebrew package upgrade failed\n");
  });

  test("reports successful Homebrew work when Pi update fails", async () => {
    const fixture = await makeFixture();
    const processes = new FailingCommandDelegate(["pi", "update", "--all"]);

    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      processes,
    }).execute({
      argv: ["upgrade", "--yes"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain("Homebrew packages upgraded\n");
    expect(outcome.stdout).toEndWith(
      "FAILED Pi update: Pi and configured package update failed\n",
    );
    expect(outcome.stderr).toBe(
      "dot: Pi and configured package update failed\n",
    );
  });

  test("allows interactive Homebrew opt-out but still updates Pi", async () => {
    const fixture = await makeFixture();
    const processes = new RecordingDelegate();
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
    }).execute({
      argv: ["upgrade"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome.exitCode).toBe(0);
    expect(prompts).toEqual(["Upgrade Homebrew packages? [Y/n]: "]);
    expect(
      processes.requests
        .map((request) => request.argv)
        .filter((argv) => argv[0] === "brew" || argv[0] === "pi"),
    ).toEqual([
      [
        "brew",
        "bundle",
        "check",
        "--no-upgrade",
        "--file",
        join(fixture.checkout, "packages/bundle"),
      ],
      ["pi", "update", "--all"],
    ]);
    expect(outcome.stdout).toEndWith(
      "Homebrew upgrade skipped\nPi and configured packages updated\n",
    );
  });

  test("refuses noninteractive upgrade before subprocesses without --yes", async () => {
    const fixture = await makeFixture();
    const processes = new RecordingDelegate();
    const terminal: Terminal = {
      interactive: false,
      async prompt() {
        throw new Error("unexpected prompt");
      },
      write() {},
    };

    expect(
      await createApplication({
        checkoutRoot: fixture.checkout,
        processes,
        terminal,
      }).execute({
        argv: ["upgrade"],
        cwd: fixture.checkout,
        env: fixture.env,
      }),
    ).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dot: dot upgrade requires an interactive terminal or --yes\n",
    });
    expect(processes.requests).toHaveLength(0);
  });

  test("Bun-side update delegates to apply without Git refresh", async () => {
    const fixture = await makeFixture();
    const processes = new RecordingDelegate();
    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      processes,
    }).execute({ argv: ["update", "--yes"], cwd: fixture.checkout, env: fixture.env });

    expect(outcome.exitCode).toBe(0);
    expect(processes.requests.some((request) => request.argv.includes("fetch"))).toBe(false);
    expect(processes.requests.some((request) => request.argv.includes("merge"))).toBe(false);
    expect(processes.requests.some((request) => request.argv.includes("upgrade"))).toBe(false);
  });
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
      stdout:
        "FAILED checkout validation: canonical checkout is behind origin/main; run 'dot update'\n",
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
        "Skill links valid (0)\nPackages already current\nDotfiles stowed\nPi settings synced\nPi dependency workspace not tracked (skipped)\n",
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
        "Skill links valid (0)\nPackages already current\nDotfiles stowed\nPi settings synced\nPi dependency workspace not tracked (skipped)\n",
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
        "Skill links valid (0)\nPackages already current\nDotfiles stowed\nPi settings already current\nPi dependency workspace not tracked (skipped)\n",
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
        "Skill links valid (0)\nPackages already current\nDotfiles stowed\nPi settings synced\nPi dependency workspace not tracked (skipped)\n",
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
      stdout: "FAILED Pi settings preflight: Pi runtime settings contains invalid JSON\n",
      stderr: "dot: Pi runtime settings contains invalid JSON\n",
    });
    expect(await readFile(settingsPath, "utf8")).toBe("{ invalid json\n");
    expect((await lstat(settingsPath)).mode & 0o777).toBe(0o640);
    expect(await Bun.file(join(fixture.home, ".dot-apply-fixture")).exists()).toBe(false);
  });

  test("preserves existing settings when the atomic replacement cannot start", async () => {
    const fixture = await makeFixture();
    const settingsDirectory = join(fixture.home, ".pi/agent");
    const settingsPath = join(settingsDirectory, "settings.json");
    const original = '{"theme":"custom","packages":[]}\n';
    await mkdir(settingsDirectory, { recursive: true });
    await writeFile(settingsPath, original, { mode: 0o600 });
    await chmod(settingsDirectory, 0o500);

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply"],
      cwd: fixture.checkout,
      env: fixture.env,
    });
    await chmod(settingsDirectory, 0o700);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain("FAILED Pi settings synchronization:");
    expect(await readFile(settingsPath, "utf8")).toBe(original);
    expect((await readdir(settingsDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
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
