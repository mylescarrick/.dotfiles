import { describe, expect, test } from "bun:test";
import { application } from "../src/application";

describe("DotApplication", () => {
  test("shows help for the help command", async () => {
    const outcome = await application.execute({
      argv: ["help"],
      cwd: "/tmp/checkout",
      env: {},
    });

    expect(outcome).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `dot - manage this macOS development environment

USAGE
  dot                     Update, apply, then reconcile any drift
  dot COMMAND [OPTIONS]
  dot --help
  dot --version

COMMANDS
  apply                 Apply the checked-out desired state
  update                Refresh origin/main, then apply
  upgrade               Update, then upgrade Bun, Homebrew, and Pi (repairs stale casks)
  doctor                Inspect managed state without changing it
  init                  Bootstrap a new machine, then apply
  outdated [--refresh]  Show outdated Homebrew, Bun and Pi packages (--refresh checks now)
  drift                 Print skill drift as JSON
  drift restore NAME    Discard local drift for one skill
  drift ignore [NAME]   Stop asking about drift (all, or one NAME)
  reconcile             Absorb drift into a PR via the Pi agent
  pi auth cloudflare    Configure private Pi Cloudflare auth
  pi auth exa           Configure private web-tools Exa search auth
  help                  Show this help
`,
    });
  });

  test("accepts help as a command or global option", async () => {
    const help = await application.execute({ argv: ["help"], cwd: "/tmp/checkout", env: {} });

    expect(await application.execute({ argv: ["--help"], cwd: "/tmp/checkout", env: {} })).toEqual(help);
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
});
