import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcilePiDependencies } from "../src/pi-dependencies";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/process";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  checkout: string;
  home: string;
  liveWorkspace: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "dot-pi-deps-"));
  temporaryDirectories.push(home);
  const checkout = join(home, ".dotfiles");
  const trackedWorkspace = join(checkout, "home/.pi");
  const liveWorkspace = join(home, ".pi");
  await mkdir(trackedWorkspace, { recursive: true });
  await mkdir(liveWorkspace, { recursive: true });
  const manifest = '{"name":"pi-workspace","dependencies":{"example":"1.0.0"}}\n';
  await writeFile(join(trackedWorkspace, "package.json"), manifest);
  await writeFile(join(liveWorkspace, "package.json"), manifest);
  return { checkout, home, liveWorkspace };
}

class InstallingProcess implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  constructor(
    private readonly liveWorkspace: string,
    private readonly result: ProcessResult = { exitCode: 0, stdout: "", stderr: "" },
  ) {}
  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    if (this.result.exitCode === 0) {
      await mkdir(join(this.liveWorkspace, "node_modules/example"), { recursive: true });
      await writeFile(join(this.liveWorkspace, "bun.lock"), "lock-v1\n");
    }
    return this.result;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("Pi dependency reconciliation", () => {
  test("installs once and records convergence", async () => {
    const state = await fixture();
    const processes = new InstallingProcess(state.liveWorkspace);
    const options = {
      checkoutRoot: state.checkout,
      home: state.home,
      env: { HOME: state.home },
      processes,
    };

    expect(await reconcilePiDependencies(options)).toBe("Pi dependencies installed\n");
    expect(processes.requests).toEqual([
      {
        argv: ["bun", "install"],
        cwd: state.liveWorkspace,
        env: { HOME: state.home },
        output: "inherit",
      },
    ]);
    expect(
      JSON.parse(
        await readFile(
          join(state.liveWorkspace, "node_modules/.dotfiles-install-state.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ schema: 1 });

    expect(await reconcilePiDependencies(options)).toBe(
      "Pi dependencies already current\n",
    );
    expect(processes.requests).toHaveLength(1);
  });

  test("manifest drift triggers another install", async () => {
    const state = await fixture();
    const processes = new InstallingProcess(state.liveWorkspace);
    const options = {
      checkoutRoot: state.checkout,
      home: state.home,
      env: {},
      processes,
    };
    await reconcilePiDependencies(options);
    await writeFile(
      join(state.checkout, "home/.pi/package.json"),
      '{"name":"pi-workspace","dependencies":{"example":"2.0.0"}}\n',
    );

    expect(await reconcilePiDependencies(options)).toBe("Pi dependencies installed\n");
    expect(processes.requests).toHaveLength(2);
  });

  test("failed installation leaves no convergence marker and retries", async () => {
    const state = await fixture();
    const failing = new InstallingProcess(state.liveWorkspace, {
      exitCode: 1,
      stdout: "",
      stderr: "failed",
    });
    const options = {
      checkoutRoot: state.checkout,
      home: state.home,
      env: {},
      processes: failing,
    };

    await expect(reconcilePiDependencies(options)).rejects.toThrow(
      "failed to install Pi workspace dependencies",
    );
    expect(
      await Bun.file(
        join(state.liveWorkspace, "node_modules/.dotfiles-install-state.json"),
      ).exists(),
    ).toBe(false);
  });
});
