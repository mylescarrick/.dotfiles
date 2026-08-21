import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStaleCasks, reconcilePackages, repairStaleCasks } from "../src/packages";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/process";

const temporaryDirectories: string[] = [];

class RecordingProcesses implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  constructor(private readonly results: ProcessResult[]) {}
  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return this.results.shift() ?? { exitCode: 0, stderr: "", stdout: "" };
  }
}

async function checkoutFixture(): Promise<string> {
  const checkout = await mkdtemp(join(tmpdir(), "dot-packages-"));
  temporaryDirectories.push(checkout);
  await mkdir(join(checkout, "packages"));
  await writeFile(join(checkout, "packages/bundle"), 'brew "stow"\n');
  return checkout;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("package reconciliation", () => {
  test("checks local declared state without upgrades", async () => {
    const checkout = await checkoutFixture();
    const processes = new RecordingProcesses([{ exitCode: 0, stderr: "", stdout: "satisfied" }]);

    expect(await reconcilePackages({ checkoutRoot: checkout, env: { HOME: "/home/test" }, processes })).toBe(
      "Packages already current\n"
    );
    expect(processes.requests).toEqual([
      {
        argv: ["brew", "bundle", "check", "--no-upgrade", "--file", join(checkout, "packages/bundle")],
        cwd: checkout,
        env: {
          HOME: "/home/test",
          HOMEBREW_BUNDLE_BREW_SKIP: undefined,
          HOMEBREW_BUNDLE_CASK_SKIP: undefined,
          HOMEBREW_NO_AUTO_UPDATE: "1",
        },
      },
    ]);
  });

  test("installs once when declared state is missing", async () => {
    const checkout = await checkoutFixture();
    const processes = new RecordingProcesses([
      { exitCode: 1, stderr: "", stdout: "missing" },
      { exitCode: 0, stderr: "", stdout: "installed" },
    ]);

    expect(await reconcilePackages({ checkoutRoot: checkout, env: {}, processes })).toBe(
      "Declared packages installed\n"
    );
    expect(processes.requests.map((request) => request.argv)).toEqual([
      ["brew", "bundle", "check", "--no-upgrade", "--file", join(checkout, "packages/bundle")],
      ["brew", "bundle", "install", "--no-upgrade", "--file", join(checkout, "packages/bundle")],
    ]);
    expect(processes.requests.flatMap((request) => request.argv)).not.toContain("upgrade");
  });

  test("fails before Homebrew when the Brewfile is absent", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "dot-packages-missing-"));
    temporaryDirectories.push(checkout);
    const processes = new RecordingProcesses([]);

    await expect(reconcilePackages({ checkoutRoot: checkout, env: {}, processes })).rejects.toThrow(
      "Brewfile is missing"
    );
    expect(processes.requests).toHaveLength(0);
  });
});

describe("stale cask detection", () => {
  async function caskFixture(targetExists: boolean): Promise<{ checkout: string; target: string }> {
    const checkout = await mkdtemp(join(tmpdir(), "dot-packages-cask-"));
    temporaryDirectories.push(checkout);
    await mkdir(join(checkout, "packages"));
    const target = join(checkout, "Example.app");
    await writeFile(join(checkout, "packages/bundle"), 'cask "example"\n');
    if (targetExists) await writeFile(target, "present\n");
    return { checkout, target };
  }

  test("treats a cask as current when its linked artifact still exists", async () => {
    const { checkout, target } = await caskFixture(true);
    const processes = new RecordingProcesses([
      { exitCode: 0, stderr: "", stdout: JSON.stringify({ casks: [{ artifacts: [{ target }] }] }) },
    ]);

    expect(await findStaleCasks({ checkoutRoot: checkout, env: {}, processes })).toEqual([]);
  });

  test("flags a cask whose linked artifact is gone from disk", async () => {
    const { checkout, target } = await caskFixture(false);
    const processes = new RecordingProcesses([
      { exitCode: 0, stderr: "", stdout: JSON.stringify({ casks: [{ artifacts: [{ target }] }] }) },
    ]);

    expect(await findStaleCasks({ checkoutRoot: checkout, env: {}, processes })).toEqual(["example"]);
  });

  test("repairStaleCasks reinstalls only the stale casks it finds", async () => {
    const { checkout, target } = await caskFixture(false);
    const processes = new RecordingProcesses([
      { exitCode: 0, stderr: "", stdout: JSON.stringify({ casks: [{ artifacts: [{ target }] }] }) },
      { exitCode: 0, stderr: "", stdout: "" },
    ]);

    expect(await repairStaleCasks({ checkoutRoot: checkout, env: {}, processes })).toBe(
      "Reinstalled stale casks: example\n"
    );
    expect(processes.requests.map((request) => request.argv)).toEqual([
      ["brew", "info", "--cask", "example", "--json=v2"],
      ["brew", "reinstall", "--cask", "example"],
    ]);
  });

  test("repairStaleCasks reports nothing to do when every cask is current", async () => {
    const { checkout, target } = await caskFixture(true);
    const processes = new RecordingProcesses([
      { exitCode: 0, stderr: "", stdout: JSON.stringify({ casks: [{ artifacts: [{ target }] }] }) },
    ]);

    expect(await repairStaleCasks({ checkoutRoot: checkout, env: {}, processes })).toBe("No stale casks found\n");
  });
});
