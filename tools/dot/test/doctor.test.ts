import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";
import { bunProcessRunner, type ProcessRequest, type ProcessRunner } from "../src/process";

const temporaryDirectories: string[] = [];

class RecordingDelegate implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  async run(request: ProcessRequest) {
    this.requests.push(request);
    return bunProcessRunner.run(request);
  }
}

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
  const home = await mkdtemp(join(tmpdir(), "dot-doctor-"));
  temporaryDirectories.push(home);
  const checkout = join(home, ".dotfiles");
  await mkdir(join(checkout, "home"), { recursive: true });
  await mkdir(join(checkout, "packages"), { recursive: true });
  await mkdir(join(checkout, "config/pi"), { recursive: true });
  await writeFile(
    join(checkout, "config/pi/settings.defaults.json"),
    '{"theme":"dark","packages":[]}\n',
  );
  await writeFile(join(checkout, "home/.managed"), "tracked\n");
  await writeFile(join(checkout, "packages/bundle"), 'brew "stow"\n');
  await run(["git", "init", "--initial-branch=main"], checkout);
  await run(["git", "config", "user.name", "Dot Tests"], checkout);
  await run(["git", "config", "user.email", "dot@example.test"], checkout);
  await run(["git", "add", "."], checkout);
  await run(["git", "commit", "-m", "fixture"], checkout);
  const head = await run(["git", "rev-parse", "HEAD"], checkout);
  await run(["git", "update-ref", "refs/remotes/origin/main", head], checkout);
  await symlink(join(checkout, "home/.managed"), join(home, ".managed"));
  await mkdir(join(home, ".pi/agent"), { recursive: true });
  await writeFile(
    join(home, ".pi/agent/settings.json"),
    '{\n  "theme": "dark",\n  "packages": []\n}\n',
    {
      mode: 0o600,
    },
  );
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("dot doctor", () => {
  test("reports a healthy managed environment without network commands", async () => {
    const state = await fixture();
    const processes = new RecordingDelegate();

    const outcome = await createApplication({
      checkoutRoot: state.checkout,
      processes,
    }).execute({ argv: ["doctor"], cwd: state.checkout, env: state.env });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe("");
    expect(outcome.stdout).toContain(
      "OK    checkout: canonical main is clean and equal to last-fetched origin/main",
    );
    expect(outcome.stdout).toContain("OK    packages: Brewfile is satisfied");
    expect(outcome.stdout).toContain("0 actionable issues");
    for (const { argv } of processes.requests) {
      if (argv[0] === "git" && argv[1] === "--version") continue;
      if (argv[0] === "git") {
        expect(["rev-parse", "branch", "status", "merge-base", "ls-files"]).toContain(
          argv[3],
        );
        continue;
      }
      if (argv[0] === "brew" && argv[1] === "--version") continue;
      if (argv[0] === "pi" && argv[1] === "--version") continue;
      if (argv[0] === "brew") {
        expect(argv.slice(1, 3)).toEqual(["bundle", "check"]);
        continue;
      }
      expect(["bun --version", "stow --version"]).toContain(argv.join(" "));
    }
  });

  test("reports independent managed-state drift and exits one", async () => {
    const state = await fixture();
    await rm(join(state.home, ".managed"));
    await chmod(join(state.home, ".pi/agent/settings.json"), 0o644);

    const outcome = await createApplication({ checkoutRoot: state.checkout }).execute({
      argv: ["doctor"],
      cwd: state.checkout,
      env: state.env,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toBe("");
    expect(outcome.stdout).toContain("FAIL  dotfiles: 1 managed path(s) drifted");
    expect(outcome.stdout).toContain("FAIL  pi-settings: Pi runtime settings mode is not 0600");
    expect(outcome.stdout).toContain("2 actionable issue(s)");
  });

  test("reports missing required Pi executable", async () => {
    const state = await fixture();
    await writeFile(join(state.home, "fake-bin/pi"), "#!/bin/sh\nexit 1\n");

    const outcome = await createApplication({ checkoutRoot: state.checkout }).execute({
      argv: ["doctor"],
      cwd: state.checkout,
      env: state.env,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain("FAIL  tools: pi is unavailable");
  });

  test("reports malformed and non-private Pi auth", async () => {
    const state = await fixture();
    await writeFile(join(state.home, ".pi/agent/auth.json"), "{ invalid\n", {
      mode: 0o644,
    });

    const outcome = await createApplication({ checkoutRoot: state.checkout }).execute({
      argv: ["doctor"],
      cwd: state.checkout,
      env: state.env,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain("FAIL  pi-auth: Pi auth mode is not 0600");
    expect(outcome.stdout).toContain("FAIL  pi-auth: Pi auth contains invalid JSON");
  });

  test("reports valid Pi settings that are stale against tracked defaults", async () => {
    const state = await fixture();
    await writeFile(
      join(state.home, ".pi/agent/settings.json"),
      '{\n  "theme": "dark"\n}\n',
      { mode: 0o600 },
    );

    const outcome = await createApplication({ checkoutRoot: state.checkout }).execute({
      argv: ["doctor"],
      cwd: state.checkout,
      env: state.env,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain(
      "FAIL  pi-settings: runtime settings are stale; run 'dot apply'",
    );
  });

  test("rejects arguments before performing diagnostics", async () => {
    const outcome = await createApplication({ checkoutRoot: "/missing" }).execute({
      argv: ["doctor", "--fix"],
      cwd: "/missing",
      env: {},
    });
    expect(outcome).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "dot: usage: dot doctor\n",
    });
  });
});
