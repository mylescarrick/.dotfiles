import { describe, expect, test } from "bun:test";
import { application } from "../src/application";

describe("DotApplication", () => {
  test("shows help when invoked without a command", async () => {
    const outcome = await application.execute({
      argv: [],
      cwd: "/tmp/checkout",
      env: {},
    });

    expect(outcome).toEqual({
      exitCode: 0,
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
  skills                Manage the checkout-scoped skills store
  pi auth cloudflare    Configure private Pi Cloudflare auth
  help                  Show this help
`,
      stderr: "",
    });
  });

  test("accepts help as a command or global option", async () => {
    const defaultHelp = await application.execute({
      argv: [],
      cwd: "/tmp/checkout",
      env: {},
    });

    for (const argv of [["help"], ["--help"]]) {
      expect(
        await application.execute({ argv, cwd: "/tmp/checkout", env: {} }),
      ).toEqual(defaultHelp);
    }
  });

  test("reports the package version", async () => {
    expect(
      await application.execute({
        argv: ["--version"],
        cwd: "/tmp/checkout",
        env: {},
      }),
    ).toEqual({
      exitCode: 0,
      stdout: "dot version 1.0.0\n",
      stderr: "",
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
        }),
      ).toEqual({
        exitCode: 2,
        stdout: "",
        stderr: `dot: usage: dot ${command} [--yes]\n`,
      });
    },
  );

  test("rejects an unknown command with usage guidance", async () => {
    expect(
      await application.execute({
        argv: ["wat"],
        cwd: "/tmp/checkout",
        env: {},
      }),
    ).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "dot: unknown command 'wat'\nRun 'dot help' for usage.\n",
    });
  });
});
