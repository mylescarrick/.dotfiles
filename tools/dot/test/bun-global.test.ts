import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addGlobalBunPackage,
  inspectGlobalBunPackages,
  parseGlobalBunPackage,
  reconcileGlobalBunPackages,
  removeGlobalBunPackage,
} from "../src/bun-global";
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

async function checkoutFixture(manifest: string): Promise<string> {
  const checkout = await mkdtemp(join(tmpdir(), "dot-bun-global-"));
  temporaryDirectories.push(checkout);
  await mkdir(join(checkout, "packages"), { recursive: true });
  await writeFile(join(checkout, "packages/bun-global"), manifest);
  return checkout;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("parse global Bun package spec", () => {
  test.each([
    ["frog", { name: "frog" }],
    ["cloudflared@0.7.1", { name: "cloudflared", version: "0.7.1" }],
    ["@biomejs/biome", { name: "@biomejs/biome" }],
    [
      "@earendil-works/pi-coding-agent@0.84.1",
      { name: "@earendil-works/pi-coding-agent", version: "0.84.1" },
    ],
    ["  frog  ", { name: "frog" }],
    ["# comment", undefined],
    ["", undefined],
    ["@scope", undefined],
    ["../escape", undefined],
  ])("parses %s", (spec, expected) => {
    expect(parseGlobalBunPackage(spec)).toEqual(expected);
  });
});

describe("inspect global Bun packages", () => {
  test("reports current when every declared package is installed at the requested version", async () => {
    const checkout = await checkoutFixture("@biomejs/biome@2.5.8\ncloudflared@0.7.1\nfrog@1.1.0\n");
    const stdout = [
      "/Users/test/.bun/install/global node_modules (3)",
      "├── @biomejs/biome@2.5.8",
      "├── cloudflared@0.7.1",
      "└── frog@1.1.0",
    ].join("\n");
    const processes = new RecordingProcesses([{ exitCode: 0, stderr: "", stdout }]);

    expect(await inspectGlobalBunPackages({ checkoutRoot: checkout, env: {}, processes })).toBe(true);
    expect(processes.requests[0]!.argv).toEqual(["bun", "pm", "ls", "-g"]);
  });

  test("reports missing when a package is absent", async () => {
    const checkout = await checkoutFixture("frog@1.1.0\n");
    const stdout = "/Users/test/.bun/install/global node_modules (0)\n";
    const processes = new RecordingProcesses([{ exitCode: 0, stderr: "", stdout }]);

    expect(await inspectGlobalBunPackages({ checkoutRoot: checkout, env: {}, processes })).toBe(false);
  });

  test("reports missing when an installed version differs", async () => {
    const checkout = await checkoutFixture("frog@1.1.0\n");
    const stdout = ["/Users/test/.bun/install/global node_modules (1)", "└── frog@1.0.0"].join("\n");
    const processes = new RecordingProcesses([{ exitCode: 0, stderr: "", stdout }]);

    expect(await inspectGlobalBunPackages({ checkoutRoot: checkout, env: {}, processes })).toBe(false);
  });

  test("treats a missing bun pm ls as not current", async () => {
    const checkout = await checkoutFixture("frog@1.1.0\n");
    const processes = new RecordingProcesses([{ exitCode: 1, stderr: "not found", stdout: "" }]);

    expect(await inspectGlobalBunPackages({ checkoutRoot: checkout, env: {}, processes })).toBe(false);
  });

  test("is current when manifest is empty", async () => {
    const checkout = await checkoutFixture("# nothing\n");
    const processes = new RecordingProcesses([]);

    expect(await inspectGlobalBunPackages({ checkoutRoot: checkout, env: {}, processes })).toBe(true);
  });
});

describe("reconcile global Bun packages", () => {
  test("is silent when manifest is empty", async () => {
    const checkout = await checkoutFixture("# nothing\n");
    const processes = new RecordingProcesses([]);

    expect(await reconcileGlobalBunPackages({ checkoutRoot: checkout, env: {}, processes })).toBe("");
    expect(processes.requests).toHaveLength(0);
  });

  test("installs missing packages in one command", async () => {
    const checkout = await checkoutFixture("frog@1.1.0\nwrangler@4.114.0\n");
    const processes = new RecordingProcesses([
      {
        exitCode: 0,
        stderr: "",
        stdout: "/Users/test/.bun/install/global node_modules (0)\n",
      },
      { exitCode: 0, stderr: "", stdout: "" },
    ]);

    expect(await reconcileGlobalBunPackages({ checkoutRoot: checkout, env: {}, processes })).toBe(
      "Installed 2 global Bun package(s)\n"
    );
    expect(processes.requests[1]!.argv).toEqual(["bun", "add", "-g", "frog@1.1.0", "wrangler@4.114.0"]);
  });

  test("skips installation when all packages are current", async () => {
    const checkout = await checkoutFixture("frog@1.1.0\n");
    const processes = new RecordingProcesses([
      {
        exitCode: 0,
        stderr: "",
        stdout: ["/Users/test/.bun/install/global node_modules (1)", "└── frog@1.1.0"].join("\n"),
      },
    ]);

    expect(await reconcileGlobalBunPackages({ checkoutRoot: checkout, env: {}, processes })).toBe(
      "Global Bun packages already current\n"
    );
    expect(processes.requests).toHaveLength(1);
  });

  test("throws when installation fails", async () => {
    const checkout = await checkoutFixture("frog@1.1.0\n");
    const processes = new RecordingProcesses([
      {
        exitCode: 0,
        stderr: "",
        stdout: "/Users/test/.bun/install/global node_modules (0)\n",
      },
      { exitCode: 1, stderr: "network error", stdout: "" },
    ]);

    await expect(reconcileGlobalBunPackages({ checkoutRoot: checkout, env: {}, processes })).rejects.toThrow(
      "failed to install declared global Bun packages"
    );
  });
});

describe("author global Bun packages", () => {
  test("add records a sorted package before installing", async () => {
    const checkout = await checkoutFixture("frog@1.1.0\nwrangler@4.114.0\n");
    const processes = new RecordingProcesses([{ exitCode: 0, stderr: "", stdout: "" }]);

    const stdout = await addGlobalBunPackage({
      checkoutRoot: checkout,
      env: {},
      name: "cloudflared@0.7.1",
      processes,
    });

    expect(stdout).toBe("Added and installed global Bun package 'cloudflared@0.7.1'\n");
    expect(await readFile(join(checkout, "packages/bun-global"), "utf8")).toBe(
      "cloudflared@0.7.1\nfrog@1.1.0\nwrangler@4.114.0\n"
    );
    expect(processes.requests[0]!.argv).toEqual(["bun", "add", "-g", "cloudflared@0.7.1"]);
  });

  test("add keeps failed installation declared for a later apply", async () => {
    const checkout = await checkoutFixture("frog@1.1.0\n");
    const processes = new RecordingProcesses([{ exitCode: 1, stderr: "failed", stdout: "" }]);

    await expect(
      addGlobalBunPackage({
        checkoutRoot: checkout,
        env: {},
        name: "cloudflared@0.7.1",
        processes,
      })
    ).rejects.toThrow("remains declared for the next dot apply");
    expect(await readFile(join(checkout, "packages/bun-global"), "utf8")).toContain("cloudflared@0.7.1");
  });

  test("add rejects an already-declared package", async () => {
    const checkout = await checkoutFixture("frog@1.1.0\n");
    const processes = new RecordingProcesses([]);

    await expect(
      addGlobalBunPackage({ checkoutRoot: checkout, env: {}, name: "frog@2.0.0", processes })
    ).rejects.toThrow("global Bun package 'frog' is already declared");
  });

  test("remove edits the manifest without uninstalling", async () => {
    const checkout = await checkoutFixture("frog@1.1.0\nwrangler@4.114.0\n");
    const processes = new RecordingProcesses([]);

    const stdout = await removeGlobalBunPackage({ checkoutRoot: checkout, name: "frog" });

    expect(stdout).toBe("Removed global Bun package 'frog' from the manifest\n");
    expect(await readFile(join(checkout, "packages/bun-global"), "utf8")).toBe("wrangler@4.114.0\n");
    expect(processes.requests).toHaveLength(0);
  });

  test("remove ignores version when matching by name", async () => {
    const checkout = await checkoutFixture("frog@1.1.0\n");

    const stdout = await removeGlobalBunPackage({ checkoutRoot: checkout, name: "frog@9.9.9" });

    expect(stdout).toBe("Removed global Bun package 'frog' from the manifest\n");
    expect(await readFile(join(checkout, "packages/bun-global"), "utf8")).toBe("\n");
  });

  test("remove reports a package that is not declared", async () => {
    const checkout = await checkoutFixture("frog@1.1.0\n");

    const stdout = await removeGlobalBunPackage({ checkoutRoot: checkout, name: "missing" });

    expect(stdout).toBe("Global Bun package 'missing' is not declared\n");
  });
});
