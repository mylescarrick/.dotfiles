import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";
import type { ProcessRequest, ProcessRunner } from "../src/process";

const temporaryDirectories: string[] = [];

class RecordingProcesses implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  constructor(private readonly exitCode = 0) {}
  async run(request: ProcessRequest) {
    this.requests.push(request);
    return { exitCode: this.exitCode, stdout: "", stderr: "" };
  }
}

async function fixture(): Promise<string> {
  const checkout = await mkdtemp(join(tmpdir(), "dot-package-authoring-"));
  temporaryDirectories.push(checkout);
  await mkdir(join(checkout, "packages"));
  await writeFile(
    join(checkout, "packages/bundle"),
    'brew "btop"\nbrew "stow"\n\ncask "discord"\ncask "raycast"\n',
  );
  return checkout;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("package authoring", () => {
  test("records a sorted formula before installing with argv boundaries", async () => {
    const checkout = await fixture();
    const processes = new RecordingProcesses();
    const outcome = await createApplication({ checkoutRoot: checkout, processes }).execute({
      argv: ["package", "add", "ripgrep"],
      cwd: checkout,
      env: { HOME: "/tmp/home" },
    });

    expect(outcome.exitCode).toBe(0);
    expect(await readFile(join(checkout, "packages/bundle"), "utf8")).toBe(
      'brew "btop"\nbrew "ripgrep"\nbrew "stow"\n\ncask "discord"\ncask "raycast"\n',
    );
    expect(processes.requests[0]).toMatchObject({
      argv: ["brew", "install", "ripgrep"],
      cwd: checkout,
      env: { HOMEBREW_NO_AUTO_UPDATE: "1" },
    });
  });

  test("uses explicit cask installation", async () => {
    const checkout = await fixture();
    const processes = new RecordingProcesses();
    await createApplication({ checkoutRoot: checkout, processes }).execute({
      argv: ["package", "add", "ghostty", "--cask"],
      cwd: checkout,
      env: {},
    });
    expect(processes.requests[0]!.argv).toEqual([
      "brew",
      "install",
      "--cask",
      "ghostty",
    ]);
  });

  test("keeps failed installation declared for a later apply", async () => {
    const checkout = await fixture();
    const outcome = await createApplication({
      checkoutRoot: checkout,
      processes: new RecordingProcesses(1),
    }).execute({
      argv: ["package", "add", "jq"],
      cwd: checkout,
      env: {},
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("remains declared for the next dot apply");
    expect(await readFile(join(checkout, "packages/bundle"), "utf8")).toContain(
      'brew "jq"',
    );
  });

  test("rejects a package already declared as the other type", async () => {
    const checkout = await fixture();
    const processes = new RecordingProcesses();
    const outcome = await createApplication({ checkoutRoot: checkout, processes }).execute({
      argv: ["package", "add", "raycast"],
      cwd: checkout,
      env: {},
    });

    expect(outcome).toMatchObject({
      exitCode: 1,
      stderr: "dot: package 'raycast' is already declared as cask\n",
    });
    expect(processes.requests).toHaveLength(0);
  });

  test("remove handles entries with Homebrew options without uninstalling", async () => {
    const checkout = await fixture();
    await writeFile(
      join(checkout, "packages/bundle"),
      'brew "postgresql@16", restart_service: :changed\nbrew "stow"\n',
    );
    const processes = new RecordingProcesses();
    const outcome = await createApplication({ checkoutRoot: checkout, processes }).execute({
      argv: ["package", "remove", "postgresql@16"],
      cwd: checkout,
      env: {},
    });

    expect(outcome.exitCode).toBe(0);
    expect(await readFile(join(checkout, "packages/bundle"), "utf8")).not.toContain(
      "postgresql@16",
    );
    expect(processes.requests).toHaveLength(0);
  });

  test("remove edits desired state without uninstalling", async () => {
    const checkout = await fixture();
    const processes = new RecordingProcesses();
    const outcome = await createApplication({ checkoutRoot: checkout, processes }).execute({
      argv: ["package", "remove", "stow"],
      cwd: checkout,
      env: {},
    });

    expect(outcome.exitCode).toBe(0);
    expect(await readFile(join(checkout, "packages/bundle"), "utf8")).not.toContain(
      'brew "stow"',
    );
    expect(processes.requests).toHaveLength(0);
  });

  test("rejects missing or unsafe names before file access", async () => {
    const app = createApplication({ checkoutRoot: "/missing" });
    expect(
      await app.execute({ argv: ["package", "add"], cwd: "/missing", env: {} }),
    ).toMatchObject({ exitCode: 2 });
    expect(
      await app.execute({
        argv: ["package", "add", 'bad"name'],
        cwd: "/missing",
        env: {},
      }),
    ).toMatchObject({ exitCode: 1, stderr: "dot: invalid package name\n" });
  });
});
