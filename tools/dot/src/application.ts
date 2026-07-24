import { resolve } from "node:path";
import packageMetadata from "../package.json";
import { apply, ApplyFailure } from "./apply";
import { runDoctor } from "./diagnostics";
import { initialize } from "./init";
import { addPackage, removePackage } from "./package-authoring";
import { configureCloudflareAuth, parseCloudflareAuthArgs } from "./pi-auth";
import { bunProcessRunner, type ProcessRunner } from "./process";
import { listSkills, syncSkillLinks } from "./skills-authoring";
import { runSkillsMutation } from "./skills-workflow";
import { systemTerminal, type Terminal } from "./terminal";
import { upgrade, UpgradeFailure } from "./upgrade";

export interface Invocation {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface CommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DotApplication {
  execute(invocation: Invocation): Promise<CommandOutcome>;
}

interface CommandDescription {
  readonly usage: string;
  readonly summary: string;
}

interface ApplicationDependencies {
  readonly checkoutRoot: string;
  readonly knownBrewPaths?: readonly string[];
  readonly processes?: ProcessRunner;
  readonly terminal?: Terminal;
}

const commands: readonly CommandDescription[] = [
  { usage: "apply", summary: "Apply the checked-out desired state" },
  { usage: "update", summary: "Refresh origin/main, then apply" },
  { usage: "upgrade", summary: "Update, then upgrade Homebrew and Pi" },
  { usage: "doctor", summary: "Inspect managed state without changing it" },
  { usage: "init", summary: "Bootstrap a new machine, then apply" },
  { usage: "package add/remove", summary: "Edit the Brewfile" },
  { usage: "skills", summary: "Manage the checkout-scoped skills store" },
  { usage: "pi auth cloudflare", summary: "Configure private Pi Cloudflare auth" },
  { usage: "help", summary: "Show this help" },
];

function failureOutcome(error: unknown): CommandOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    exitCode: 1,
    stdout:
      error instanceof ApplyFailure || error instanceof UpgradeFailure
        ? error.stdout
        : "",
    stderr: `dot: ${message}\n`,
  };
}

function renderHelp(): string {
  const commandLines = commands
    .map(({ usage, summary }) => `  ${usage.padEnd(22)}${summary}`)
    .join("\n");

  return `dot - manage this macOS development environment

USAGE
  dot COMMAND [OPTIONS]
  dot --help
  dot --version

COMMANDS
${commandLines}
`;
}

export function createApplication(
  dependencies: ApplicationDependencies,
): DotApplication {
  const processes = dependencies.processes ?? bunProcessRunner;
  const terminal = dependencies.terminal ?? systemTerminal;
  return {
    async execute(invocation) {
      const [command] = invocation.argv;
      if (
        invocation.argv.length === 0 ||
        (invocation.argv.length === 1 &&
          (command === "help" || command === "--help"))
      ) {
        return { exitCode: 0, stdout: renderHelp(), stderr: "" };
      }

      if (invocation.argv.length === 1 && command === "--version") {
        return {
          exitCode: 0,
          stdout: `dot version ${packageMetadata.version}\n`,
          stderr: "",
        };
      }

      if (command === "init") {
        if (invocation.argv.length !== 1) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: "dot: usage: dot init\n",
          };
        }
        try {
          const outcome = await initialize({
            checkoutRoot: dependencies.checkoutRoot,
            env: invocation.env,
            knownBrewPaths: dependencies.knownBrewPaths,
            processes,
            terminal,
          });
          return { ...outcome, stderr: "" };
        } catch (error) {
          return failureOutcome(error);
        }
      }

      if (command === "skills") {
        const action = invocation.argv[1] ?? "list";
        let args = invocation.argv.slice(2);
        let acceptAll = false;
        if (
          (action === "update" || action === "add" || action === "remove") &&
          args.at(-1) === "--yes"
        ) {
          acceptAll = true;
          args = args.slice(0, -1);
        }
        const valid =
          (action === "list" && args.length === 0) ||
          (action === "sync" && args.length === 0) ||
          (action === "update" && args.length === 0) ||
          (action === "add" && args.length >= 2) ||
          (action === "remove" && args.length >= 1);
        if (!valid) {
          return {
            exitCode: 2,
            stdout: "",
            stderr:
              "dot: usage: dot skills [list|sync|update [--yes]|add REPO SKILL... [--yes]|remove SKILL... [--yes]]\n",
          };
        }
        try {
          const stdout =
            action === "list"
              ? await listSkills(dependencies.checkoutRoot)
              : action === "sync"
                ? await syncSkillLinks({
                    checkoutRoot: dependencies.checkoutRoot,
                    env: invocation.env,
                    processes,
                  })
                : await runSkillsMutation({
                    action: action as "add" | "update" | "remove",
                    args,
                    acceptAll,
                    checkoutRoot: dependencies.checkoutRoot,
                    env: invocation.env,
                    processes,
                    terminal,
                  });
          return { exitCode: 0, stdout, stderr: "" };
        } catch (error) {
          return failureOutcome(error);
        }
      }

      if (command === "pi") {
        if (invocation.argv[1] !== "auth" || invocation.argv[2] !== "cloudflare") {
          return {
            exitCode: 2,
            stdout: "",
            stderr: "dot: usage: dot pi auth cloudflare [OPTIONS]\n",
          };
        }
        const parsed = parseCloudflareAuthArgs(invocation.argv.slice(3));
        if (!parsed.ok) {
          return { exitCode: 2, stdout: "", stderr: parsed.message };
        }
        const home = invocation.env.HOME;
        if (!home) return { exitCode: 1, stdout: "", stderr: "dot: HOME is required\n" };
        try {
          const stdout = await configureCloudflareAuth({
            ...parsed.input,
            env: invocation.env,
            home,
            terminal,
          });
          return { exitCode: 0, stdout, stderr: "" };
        } catch (error) {
          return failureOutcome(error);
        }
      }

      if (command === "package") {
        const [, action, name, option] = invocation.argv;
        const validAdd =
          action === "add" &&
          Boolean(name) &&
          (invocation.argv.length === 3 ||
            (invocation.argv.length === 4 && option === "--cask"));
        const validRemove = action === "remove" && Boolean(name) && invocation.argv.length === 3;
        if (!validAdd && !validRemove) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: "dot: usage: dot package add NAME [--cask] | dot package remove NAME\n",
          };
        }
        try {
          const stdout = validAdd
            ? await addPackage({
                cask: option === "--cask",
                checkoutRoot: dependencies.checkoutRoot,
                env: invocation.env,
                name: name!,
                processes,
              })
            : await removePackage({ checkoutRoot: dependencies.checkoutRoot, name: name! });
          return { exitCode: 0, stdout, stderr: "" };
        } catch (error) {
          return failureOutcome(error);
        }
      }

      if (command === "doctor") {
        if (invocation.argv.length !== 1) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: "dot: usage: dot doctor\n",
          };
        }
        try {
          const report = await runDoctor({
            checkoutRoot: dependencies.checkoutRoot,
            env: invocation.env,
            processes,
          });
          return {
            exitCode: report.healthy ? 0 : 1,
            stdout: report.stdout,
            stderr: "",
          };
        } catch (error) {
          return failureOutcome(error);
        }
      }

      if (command === "apply" || command === "update" || command === "upgrade") {
        if (
          invocation.argv.length > 2 ||
          (invocation.argv.length === 2 && invocation.argv[1] !== "--yes")
        ) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: `dot: usage: dot ${command} [--yes]\n`,
          };
        }
        try {
          const options = {
            checkoutRoot: dependencies.checkoutRoot,
            env: invocation.env,
            processes,
            terminal,
          };
          return {
            exitCode: 0,
            stdout:
              command === "upgrade"
                ? await upgrade({
                    ...options,
                    acceptAll: invocation.argv[1] === "--yes",
                  })
                : await apply({
                    ...options,
                    acceptTracked: invocation.argv[1] === "--yes",
                  }),
            stderr: "",
          };
        } catch (error) {
          return failureOutcome(error);
        }
      }

      return {
        exitCode: 2,
        stdout: "",
        stderr: `dot: unknown command '${command}'\nRun 'dot help' for usage.\n`,
      };
    },
  };
}

export const application = createApplication({
  checkoutRoot: resolve(import.meta.dir, "../../.."),
});
