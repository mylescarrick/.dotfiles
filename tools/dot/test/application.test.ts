import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { application, createApplication } from "../src/application";

const temporaryDirectories: string[] = [];

async function bunGlobalFixture(): Promise<string> {
  const checkout = await mkdtemp(join(tmpdir(), "dot-application-bun-"));
  temporaryDirectories.push(checkout);
  await mkdir(join(checkout, "packages"), { recursive: true });
  await Bun.write(join(checkout, "packages/bun-global"), "frog@1.1.0\n");
  return checkout;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("DotApplication", () => {
  test("shows help when invoked without a command", async () => {
    const outcome = await application.execute({
      argv: [],
      cwd: "/tmp/checkout",
      env: {},
    });

    expect(outcome).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `dot - manage this macOS development environment

USAGE
  dot COMMAND [OPTIONS]
  dot --help
  dot --version

COMMANDS
  apply                 Apply the checked-out desired state
  update                Refresh origin/main, then apply
  upgrade               Update, then upgrade Homebrew and Pi
  doctor                Inspect managed state without changing it
  init                  Bootstrap a new machine, then apply
  package add/remove    Edit the Brewfile
  bun add/remove        Edit the global Bun package manifest
  skills                Manage the checkout-scoped skills store
  pi auth cloudflare    Configure private Pi Cloudflare auth
  pi auth exa           Configure private web-tools Exa search auth
  help                  Show this help
`,
    });
  });

  test("accepts help as a command or global option", async () => {
    const defaultHelp = await application.execute({
      argv: [],
      cwd: "/tmp/checkout",
      env: {},
    });

    for (const argv of [["help"], ["--help"]]) {
      expect(await application.execute({ argv, cwd: "/tmp/checkout", env: {} })).toEqual(defaultHelp);
    }
  });

  test("reports the package version", async () => {
    expect(
      await application.execute({
        argv: ["--version"],
        cwd: "/tmp/checkout",
        env: {},
      })
    ).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "dot version 1.0.0\n",
    });
  });

  test.each(["apply", "upgrade"])(
    "rejects invalid %s arguments before inspecting the checkout",
    async (command) => {
      expect(
        await application.execute({
          argv: [command, "--force"],
          cwd: "/tmp/checkout",
          env: {},
        })
      ).toEqual({
        exitCode: 2,
        stderr: `dot: usage: dot ${command} [--yes]\n`,
        stdout: "",
      });
    }
  );

  test("rejects an unknown command with usage guidance", async () => {
    expect(
      await application.execute({
        argv: ["wat"],
        cwd: "/tmp/checkout",
        env: {},
      })
    ).toEqual({
      exitCode: 2,
      stderr: "dot: unknown command 'wat'\nRun 'dot help' for usage.\n",
      stdout: "",
    });
  });

  test.each([
    { argv: ["bun"], stderr: "dot: usage: dot bun add NAME[@VERSION] | dot bun remove NAME\n" },
    { argv: ["bun", "add"], stderr: "dot: usage: dot bun add NAME[@VERSION] | dot bun remove NAME\n" },
    { argv: ["bun", "add", "bad name"], stderr: "dot: invalid global Bun package name\n" },
  ])("rejects invalid bun usage for %s", async ({ argv, stderr }) => {
    const checkout = await bunGlobalFixture();
    const outcome = await createApplication({ checkoutRoot: checkout }).execute({
      argv,
      cwd: checkout,
      env: {},
    });
    expect(outcome).toMatchObject({ exitCode: argv[1] === "add" && argv[2] === "bad name" ? 1 : 2, stderr });
  });

  test("bun remove edits the manifest without installing", async () => {
    const checkout = await bunGlobalFixture();
    const outcome = await createApplication({ checkoutRoot: checkout }).execute({
      argv: ["bun", "remove", "frog"],
      cwd: checkout,
      env: {},
    });
    expect(outcome).toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: "Removed global Bun package 'frog' from the manifest\n",
    });
    expect(await Bun.file(join(checkout, "packages/bun-global")).text()).toBe("\n");
  });
});
