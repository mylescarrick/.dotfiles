import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcilePackages } from "../src/packages";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/process";

const temporaryDirectories: string[] = [];

class RecordingProcesses implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  constructor(private readonly results: ProcessResult[]) {}
  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return this.results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
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
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("package reconciliation", () => {
  test("checks local declared state without upgrades", async () => {
    const checkout = await checkoutFixture();
    const processes = new RecordingProcesses([
      { exitCode: 0, stdout: "satisfied", stderr: "" },
    ]);

    expect(
      await reconcilePackages({ checkoutRoot: checkout, env: { HOME: "/home/test" }, processes }),
    ).toBe("Packages already current\n");
    expect(processes.requests).toEqual([
      {
        argv: [
          "brew",
          "bundle",
          "check",
          "--no-upgrade",
          "--file",
          join(checkout, "packages/bundle"),
        ],
        cwd: checkout,
        env: {
          HOME: "/home/test",
          HOMEBREW_NO_AUTO_UPDATE: "1",
          HOMEBREW_BUNDLE_BREW_SKIP: undefined,
          HOMEBREW_BUNDLE_CASK_SKIP: undefined,
        },
      },
    ]);
  });

  test("installs once when declared state is missing", async () => {
    const checkout = await checkoutFixture();
    const processes = new RecordingProcesses([
      { exitCode: 1, stdout: "missing", stderr: "" },
      { exitCode: 0, stdout: "installed", stderr: "" },
    ]);

    expect(
      await reconcilePackages({ checkoutRoot: checkout, env: {}, processes }),
    ).toBe("Declared packages installed\n");
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

    await expect(
      reconcilePackages({ checkoutRoot: checkout, env: {}, processes }),
    ).rejects.toThrow("Brewfile is missing");
    expect(processes.requests).toHaveLength(0);
  });
});
