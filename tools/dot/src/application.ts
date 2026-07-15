import packageMetadata from "../package.json";

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

export const application: DotApplication = {
  async execute(invocation) {
    const [command] = invocation.argv;
    if (
      invocation.argv.length === 0 ||
      (invocation.argv.length === 1 && (command === "help" || command === "--help"))
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

    return {
      exitCode: 2,
      stdout: "",
      stderr: `dot: unknown command '${command}'\nRun 'dot help' for usage.\n`,
    };
  },
};
