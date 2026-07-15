import { resolve } from "node:path";
import packageMetadata from "../package.json";
import { apply } from "./apply";
import { bunProcessRunner, type ProcessRunner } from "./process";
import { systemTerminal, type Terminal } from "./terminal";

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
  readonly processes?: ProcessRunner;
  readonly terminal?: Terminal;
}

const commands: readonly CommandDescription[] = [
  { usage: "apply", summary: "Apply the checked-out desired state" },
  { usage: "update", summary: "Refresh origin/main, then apply" },
  { usage: "doctor", summary: "Inspect managed state without changing it" },
  { usage: "init", summary: "Bootstrap a new machine, then apply" },
  { usage: "package add/remove", summary: "Edit the Brewfile" },
  { usage: "skills", summary: "Manage the checkout-scoped skills store" },
  { usage: "pi auth cloudflare", summary: "Configure private Pi Cloudflare auth" },
  { usage: "help", summary: "Show this help" },
];

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

      if (command === "apply") {
        if (
          invocation.argv.length > 2 ||
          (invocation.argv.length === 2 && invocation.argv[1] !== "--yes")
        ) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: "dot: usage: dot apply [--yes]\n",
          };
        }
        try {
          return {
            exitCode: 0,
            stdout: await apply({
              acceptTracked: invocation.argv[1] === "--yes",
              checkoutRoot: dependencies.checkoutRoot,
              env: invocation.env,
              processes,
              terminal,
            }),
            stderr: "",
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            exitCode: 1,
            stdout: "",
            stderr: `dot: ${message}\n`,
          };
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
