import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNpmPackageName, reconcilePiPackages } from "../src/pi-packages";
import type { ProcessRequest, ProcessRunner } from "../src/process";

describe("parseNpmPackageName", () => {
  test("extracts unscoped name", () => {
    expect(parseNpmPackageName("npm:pi-mcp-adapter")).toBe("pi-mcp-adapter");
  });

  test("strips version from unscoped source", () => {
    expect(parseNpmPackageName("npm:pi-mcp-adapter@2.23.0")).toBe("pi-mcp-adapter");
  });

  test("extracts scoped name", () => {
    expect(parseNpmPackageName("npm:@mobrienv/pi-tidy-tools")).toBe("@mobrienv/pi-tidy-tools");
  });

  test("strips version from scoped source", () => {
    expect(parseNpmPackageName("npm:@mobrienv/pi-tidy-tools@0.5.0")).toBe("@mobrienv/pi-tidy-tools");
  });

  test("returns undefined for non-npm sources", () => {
    expect(parseNpmPackageName("git:github.com/foo/bar")).toBeUndefined();
    expect(parseNpmPackageName("../packages/foo")).toBeUndefined();
  });
});

class RecordingRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  async run(request: ProcessRequest) {
    this.requests.push(request);
    return { exitCode: 0, stderr: "", stdout: "" };
  }
}

class FailingRunner implements ProcessRunner {
  constructor(private readonly source: string) {}
  async run(request: ProcessRequest) {
    if (request.argv.join(" ") === `pi install ${this.source}`) {
      return { exitCode: 1, stderr: "install failed", stdout: "" };
    }
    return { exitCode: 0, stderr: "", stdout: "" };
  }
}

async function makeFixture(packages: string[]): Promise<{
  checkout: string;
  home: string;
  cleanup: () => Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "dot-pi-packages-"));
  const checkout = await mkdtemp(join(tmpdir(), "dot-pi-packages-checkout-"));
  await mkdir(join(checkout, "config/pi"), { recursive: true });
  await writeFile(
    join(checkout, "config/pi/settings.defaults.json"),
    `${JSON.stringify({ packages, theme: "dark" }, null, 2)}\n`
  );
  return {
    checkout,
    cleanup: async () => {
      await rm(home, { recursive: true });
      await rm(checkout, { recursive: true });
    },
    home,
  };
}

describe("reconcilePiPackages", () => {
  test("returns current when there are no desired packages", async () => {
    const fixture = await makeFixture([]);
    const runner = new RecordingRunner();

    const result = await reconcilePiPackages({
      checkoutRoot: fixture.checkout,
      env: {},
      home: fixture.home,
      processes: runner,
    });

    expect(result).toBe("Pi packages already current\n");
    expect(runner.requests).toHaveLength(0);
    await fixture.cleanup();
  });

  test("returns current when all desired npm packages are installed", async () => {
    const fixture = await makeFixture(["npm:pi-mcp-adapter", "npm:@mobrienv/pi-tidy-tools"]);
    await mkdir(join(fixture.home, ".pi/agent/npm"), { recursive: true });
    await writeFile(
      join(fixture.home, ".pi/agent/npm/package.json"),
      `${JSON.stringify(
        {
          dependencies: {
            "@mobrienv/pi-tidy-tools": "^0.4.1",
            "pi-mcp-adapter": "^2.23.0",
          },
          name: "pi-extensions",
          private: true,
        },
        null,
        2
      )}\n`
    );
    const runner = new RecordingRunner();

    const result = await reconcilePiPackages({
      checkoutRoot: fixture.checkout,
      env: {},
      home: fixture.home,
      processes: runner,
    });

    expect(result).toBe("Pi packages already current\n");
    expect(runner.requests).toHaveLength(0);
    await fixture.cleanup();
  });

  test("installs missing npm packages", async () => {
    const fixture = await makeFixture(["npm:pi-mcp-adapter", "npm:pi-claude-bridge"]);
    await mkdir(join(fixture.home, ".pi/agent/npm"), { recursive: true });
    await writeFile(
      join(fixture.home, ".pi/agent/npm/package.json"),
      `${JSON.stringify(
        {
          dependencies: {
            "pi-claude-bridge": "^0.7.0",
          },
          name: "pi-extensions",
          private: true,
        },
        null,
        2
      )}\n`
    );
    const runner = new RecordingRunner();

    const result = await reconcilePiPackages({
      checkoutRoot: fixture.checkout,
      env: {},
      home: fixture.home,
      processes: runner,
    });

    expect(result).toBe("Pi packages installed\n");
    expect(runner.requests.map((request) => request.argv)).toEqual([["pi", "install", "npm:pi-mcp-adapter"]]);
    await fixture.cleanup();
  });

  test("ignores non-npm sources", async () => {
    const fixture = await makeFixture(["git:github.com/foo/bar", "../packages/foo"]);
    const runner = new RecordingRunner();

    const result = await reconcilePiPackages({
      checkoutRoot: fixture.checkout,
      env: {},
      home: fixture.home,
      processes: runner,
    });

    expect(result).toBe("Pi packages already current\n");
    expect(runner.requests).toHaveLength(0);
    await fixture.cleanup();
  });

  test("throws when install fails", async () => {
    const fixture = await makeFixture(["npm:pi-mcp-adapter"]);
    await mkdir(join(fixture.home, ".pi/agent/npm"), { recursive: true });
    await writeFile(
      join(fixture.home, ".pi/agent/npm/package.json"),
      `${JSON.stringify({ dependencies: {}, name: "pi-extensions", private: true }, null, 2)}\n`
    );
    const runner = new FailingRunner("npm:pi-mcp-adapter");

    await expect(
      reconcilePiPackages({
        checkoutRoot: fixture.checkout,
        env: {},
        home: fixture.home,
        processes: runner,
      })
    ).rejects.toThrow("failed to install Pi package npm:pi-mcp-adapter");
    await fixture.cleanup();
  });
});
