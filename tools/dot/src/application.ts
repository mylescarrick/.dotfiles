import { resolve } from "node:path";
import packageMetadata from "../package.json";
import { ApplyFailure, apply } from "./apply";
import { addGlobalBunPackage, removeGlobalBunPackage } from "./bun-global";
import { runDoctor } from "./diagnostics";
import { initialize } from "./init";
import { addPackage, removePackage } from "./package-authoring";
import {
  configureCloudflareAuth,
  configureExaAuth,
  parseCloudflareAuthArgs,
  parseExaAuthArgs,
} from "./pi-auth";
import { bunProcessRunner, type ProcessRunner } from "./process";
import { listSkills, syncSkillLinks } from "./skills-authoring";
import { runSkillsMutation } from "./skills-workflow";
import { systemTerminal, type Terminal } from "./terminal";
import { UpgradeFailure, upgrade } from "./upgrade";

export interface Invocation {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface CommandOutcome {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface DotApplication {
  execute: (invocation: Invocation) => Promise<CommandOutcome>;
}

interface CommandDescription {
  readonly summary: string;
  readonly usage: string;
}

interface ApplicationDependencies {
  readonly checkoutRoot: string;
  readonly knownBrewPaths?: readonly string[];
  readonly processes?: ProcessRunner;
  readonly terminal?: Terminal;
}

const commands: readonly CommandDescription[] = [
  { summary: "Apply the checked-out desired state", usage: "apply" },
  { summary: "Refresh origin/main, then apply", usage: "update" },
  { summary: "Update, then upgrade Bun, Homebrew, and Pi (repairs stale casks)", usage: "upgrade" },
  { summary: "Inspect managed state without changing it", usage: "doctor" },
  { summary: "Bootstrap a new machine, then apply", usage: "init" },
  { summary: "Edit the Brewfile", usage: "package add/remove" },
  { summary: "Edit the global Bun package manifest", usage: "bun add/remove" },
  { summary: "Manage the checkout-scoped skills store", usage: "skills" },
  { summary: "Configure private Pi Cloudflare auth", usage: "pi auth cloudflare" },
  { summary: "Configure private web-tools Exa search auth", usage: "pi auth exa" },
  { summary: "Show this help", usage: "help" },
];

interface CommandContext {
  readonly dependencies: ApplicationDependencies;
  readonly invocation: Invocation;
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
}

function failureOutcome(error: unknown): CommandOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    exitCode: 1,
    stderr: `dot: ${message}\n`,
    stdout: error instanceof ApplyFailure || error instanceof UpgradeFailure ? error.stdout : "",
  };
}

function renderHelp(): string {
  const commandLines = commands.map(({ usage, summary }) => `  ${usage.padEnd(22)}${summary}`).join("\n");

  return `dot - manage this macOS development environment

USAGE
  dot COMMAND [OPTIONS]
  dot --help
  dot --version

COMMANDS
${commandLines}
`;
}

async function handleInit(ctx: CommandContext): Promise<CommandOutcome> {
  if (ctx.invocation.argv.length !== 1) {
    return { exitCode: 2, stderr: "dot: usage: dot init\n", stdout: "" };
  }
  try {
    const outcome = await initialize({
      checkoutRoot: ctx.dependencies.checkoutRoot,
      env: ctx.invocation.env,
      knownBrewPaths: ctx.dependencies.knownBrewPaths,
      processes: ctx.processes,
      terminal: ctx.terminal,
    });
    return { ...outcome, stderr: "" };
  } catch (error) {
    return failureOutcome(error);
  }
}

async function handleSkills(ctx: CommandContext): Promise<CommandOutcome> {
  const { invocation, dependencies, processes, terminal } = ctx;
  const action = invocation.argv[1] ?? "list";
  let args = invocation.argv.slice(2);
  let acceptAll = false;
  if ((action === "update" || action === "add" || action === "remove") && args.at(-1) === "--yes") {
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
      stderr:
        "dot: usage: dot skills [list|sync|update [--yes]|add REPO SKILL... [--yes]|remove SKILL... [--yes]]\n",
      stdout: "",
    };
  }
  try {
    let stdout: string;
    if (action === "list") {
      stdout = await listSkills(dependencies.checkoutRoot);
    } else if (action === "sync") {
      stdout = await syncSkillLinks({
        checkoutRoot: dependencies.checkoutRoot,
        env: invocation.env,
        processes,
      });
    } else {
      stdout = await runSkillsMutation({
        acceptAll,
        action: action as "add" | "update" | "remove",
        args,
        checkoutRoot: dependencies.checkoutRoot,
        env: invocation.env,
        processes,
        terminal,
      });
    }
    return { exitCode: 0, stderr: "", stdout };
  } catch (error) {
    return failureOutcome(error);
  }
}

async function handlePiAuthExa(ctx: CommandContext): Promise<CommandOutcome> {
  const parsed = parseExaAuthArgs(ctx.invocation.argv.slice(3));
  if (!parsed.ok) return { exitCode: 2, stderr: parsed.message, stdout: "" };
  const home = ctx.invocation.env.HOME;
  if (!home) return { exitCode: 1, stderr: "dot: HOME is required\n", stdout: "" };
  try {
    const stdout = await configureExaAuth({ ...parsed.input, home });
    return { exitCode: 0, stderr: "", stdout };
  } catch (error) {
    return failureOutcome(error);
  }
}

async function handlePi(ctx: CommandContext): Promise<CommandOutcome> {
  const { invocation, terminal } = ctx;
  if (invocation.argv[1] === "auth" && invocation.argv[2] === "exa") return handlePiAuthExa(ctx);

  if (invocation.argv[1] !== "auth" || invocation.argv[2] !== "cloudflare") {
    return { exitCode: 2, stderr: "dot: usage: dot pi auth cloudflare [OPTIONS]\n", stdout: "" };
  }
  const parsed = parseCloudflareAuthArgs(invocation.argv.slice(3));
  if (!parsed.ok) return { exitCode: 2, stderr: parsed.message, stdout: "" };
  const home = invocation.env.HOME;
  if (!home) return { exitCode: 1, stderr: "dot: HOME is required\n", stdout: "" };
  try {
    const stdout = await configureCloudflareAuth({ ...parsed.input, env: invocation.env, home, terminal });
    return { exitCode: 0, stderr: "", stdout };
  } catch (error) {
    return failureOutcome(error);
  }
}

async function handlePackage(ctx: CommandContext): Promise<CommandOutcome> {
  const { invocation, dependencies, processes } = ctx;
  const [, action, name, option] = invocation.argv;
  const validAdd =
    action === "add" &&
    Boolean(name) &&
    (invocation.argv.length === 3 || (invocation.argv.length === 4 && option === "--cask"));
  const validRemove = action === "remove" && Boolean(name) && invocation.argv.length === 3;
  if (!(validAdd || validRemove)) {
    return {
      exitCode: 2,
      stderr: "dot: usage: dot package add NAME [--cask] | dot package remove NAME\n",
      stdout: "",
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
    return { exitCode: 0, stderr: "", stdout };
  } catch (error) {
    return failureOutcome(error);
  }
}

async function handleBun(ctx: CommandContext): Promise<CommandOutcome> {
  const { invocation, dependencies, processes } = ctx;
  const action = invocation.argv[1];
  const name = invocation.argv[2];
  const validAdd = action === "add" && Boolean(name) && invocation.argv.length === 3;
  const validRemove = action === "remove" && Boolean(name) && invocation.argv.length === 3;
  if (!(validAdd || validRemove)) {
    return {
      exitCode: 2,
      stderr: "dot: usage: dot bun add NAME[@VERSION] | dot bun remove NAME\n",
      stdout: "",
    };
  }
  try {
    const stdout = validAdd
      ? await addGlobalBunPackage({
          checkoutRoot: dependencies.checkoutRoot,
          env: invocation.env,
          name: name!,
          processes,
        })
      : await removeGlobalBunPackage({ checkoutRoot: dependencies.checkoutRoot, name: name! });
    return { exitCode: 0, stderr: "", stdout };
  } catch (error) {
    return failureOutcome(error);
  }
}

async function handleDoctor(ctx: CommandContext): Promise<CommandOutcome> {
  if (ctx.invocation.argv.length !== 1) {
    return { exitCode: 2, stderr: "dot: usage: dot doctor\n", stdout: "" };
  }
  try {
    const report = await runDoctor({
      checkoutRoot: ctx.dependencies.checkoutRoot,
      env: ctx.invocation.env,
      processes: ctx.processes,
    });
    return { exitCode: report.healthy ? 0 : 1, stderr: "", stdout: report.stdout };
  } catch (error) {
    return failureOutcome(error);
  }
}

async function handleApplyUpdateUpgrade(
  ctx: CommandContext,
  command: "apply" | "update" | "upgrade"
): Promise<CommandOutcome> {
  const { invocation, dependencies, processes, terminal } = ctx;
  if (invocation.argv.length > 2 || (invocation.argv.length === 2 && invocation.argv[1] !== "--yes")) {
    return { exitCode: 2, stderr: `dot: usage: dot ${command} [--yes]\n`, stdout: "" };
  }
  try {
    const options = { checkoutRoot: dependencies.checkoutRoot, env: invocation.env, processes, terminal };
    const stdout =
      command === "upgrade"
        ? await upgrade({ ...options, acceptAll: invocation.argv[1] === "--yes" })
        : await apply({ ...options, acceptTracked: invocation.argv[1] === "--yes" });
    return { exitCode: 0, stderr: "", stdout };
  } catch (error) {
    return failureOutcome(error);
  }
}

const SINGLE_WORD_HANDLERS: Readonly<Record<string, (ctx: CommandContext) => Promise<CommandOutcome>>> = {
  bun: handleBun,
  doctor: handleDoctor,
  init: handleInit,
  package: handlePackage,
  pi: handlePi,
  skills: handleSkills,
};

export function createApplication(dependencies: ApplicationDependencies): DotApplication {
  const processes = dependencies.processes ?? bunProcessRunner;
  const terminal = dependencies.terminal ?? systemTerminal;
  return {
    async execute(invocation) {
      const [command] = invocation.argv;
      if (
        invocation.argv.length === 0 ||
        (invocation.argv.length === 1 && (command === "help" || command === "--help"))
      ) {
        return { exitCode: 0, stderr: "", stdout: renderHelp() };
      }
      if (invocation.argv.length === 1 && command === "--version") {
        return { exitCode: 0, stderr: "", stdout: `dot version ${packageMetadata.version}\n` };
      }

      const ctx: CommandContext = { dependencies, invocation, processes, terminal };
      if (command === "apply" || command === "update" || command === "upgrade") {
        return handleApplyUpdateUpgrade(ctx, command);
      }

      const handler = command ? SINGLE_WORD_HANDLERS[command] : undefined;
      if (handler) return handler(ctx);

      return {
        exitCode: 2,
        stderr: `dot: unknown command '${command}'\nRun 'dot help' for usage.\n`,
        stdout: "",
      };
    },
  };
}

export const application = createApplication({
  checkoutRoot: resolve(import.meta.dir, "../../.."),
});
