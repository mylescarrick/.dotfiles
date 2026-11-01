import { resolve } from "node:path";
import packageMetadata from "../package.json";
import { ApplyFailure, apply } from "./apply";
import { runDoctor } from "./diagnostics";
import { restoreFile } from "./home-deploy";
import { initialize } from "./init";
import { collectOutdated, describeOutdated, readOutdated, writeOutdated } from "./outdated";
import {
  configureCloudflareAuth,
  configureExaAuth,
  parseCloudflareAuthArgs,
  parseExaAuthArgs,
} from "./pi-auth";
import { bunProcessRunner, type ProcessRunner } from "./process";
import { buildDriftReport, ignoreDrift, reconcile } from "./reconcile";
import { disableOutdatedSchedule, enableOutdatedSchedule } from "./schedule";
import { restoreSkill } from "./skills";
import { SyncFailure, sync } from "./sync";
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
  {
    summary: "Show outdated packages (--refresh checks now; --disable/--enable the 6-hourly job)",
    usage: "outdated [--refresh]",
  },
  { summary: "Print skill drift as JSON", usage: "drift" },
  { summary: "Discard local drift for one skill", usage: "drift restore NAME" },
  { summary: "Stop asking about drift (all, or one NAME)", usage: "drift ignore [NAME]" },
  { summary: "Absorb drift into a PR via the Pi agent", usage: "reconcile" },
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
    stdout:
      error instanceof ApplyFailure || error instanceof UpgradeFailure || error instanceof SyncFailure
        ? error.stdout
        : "",
  };
}

function renderHelp(): string {
  const commandLines = commands.map(({ usage, summary }) => `  ${usage.padEnd(22)}${summary}`).join("\n");

  return `dot - manage this macOS development environment

USAGE
  dot                     Update, apply, then reconcile any drift
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

async function handleDrift(ctx: CommandContext): Promise<CommandOutcome> {
  const { invocation, dependencies, processes } = ctx;
  const [, action, name] = invocation.argv;
  const restoring = action === "restore" && Boolean(name) && invocation.argv.length === 3;
  const ignoring = action === "ignore" && invocation.argv.length <= 3;
  if (!(invocation.argv.length === 1 || restoring || ignoring)) {
    return { exitCode: 2, stderr: "dot: usage: dot drift [restore NAME | ignore [NAME]]\n", stdout: "" };
  }
  try {
    const options = { checkoutRoot: dependencies.checkoutRoot, env: invocation.env, processes };
    if (restoring) {
      const home = invocation.env.HOME;
      if (!home) throw new Error("HOME is required");
      // Files are named by their path (".zshrc", ".config/git/config"); skill names never start with a dot or hold a slash.
      const isFile = name!.startsWith(".") || name!.includes("/");
      const restore = isFile ? restoreFile : restoreSkill;
      return { exitCode: 0, stderr: "", stdout: await restore({ ...options, home, name: name! }) };
    }
    if (ignoring)
      return { exitCode: 0, stderr: "", stdout: await ignoreDrift(options, invocation.argv.slice(2)) };
    const report = await buildDriftReport(options);
    return { exitCode: 0, stderr: "", stdout: `${JSON.stringify(report, null, 2)}\n` };
  } catch (error) {
    return failureOutcome(error);
  }
}

async function handleOutdated(ctx: CommandContext): Promise<CommandOutcome> {
  const { invocation, dependencies, processes } = ctx;
  const flag = invocation.argv[1];
  const refresh = flag === "--refresh";
  const known = flag === undefined || refresh || flag === "--disable" || flag === "--enable";
  if (!(known && invocation.argv.length <= 2)) {
    return {
      exitCode: 2,
      stderr: "dot: usage: dot outdated [--refresh | --disable | --enable]\n",
      stdout: "",
    };
  }
  try {
    const home = invocation.env.HOME;
    if (!home) throw new Error("HOME is required");
    if (flag === "--disable" || flag === "--enable") {
      const control = { checkoutRoot: dependencies.checkoutRoot, env: invocation.env, home, processes };
      const stdout =
        flag === "--disable" ? await disableOutdatedSchedule(control) : await enableOutdatedSchedule(control);
      return { exitCode: 0, stderr: "", stdout };
    }
    let report = await readOutdated(invocation.env, home);
    if (refresh) {
      report = await collectOutdated({
        checkoutRoot: dependencies.checkoutRoot,
        env: invocation.env,
        home,
        previous: report,
        processes,
      });
      await writeOutdated(invocation.env, home, report);
    }
    return { exitCode: 0, stderr: "", stdout: describeOutdated(report) };
  } catch (error) {
    return failureOutcome(error);
  }
}

async function handleReconcile(ctx: CommandContext): Promise<CommandOutcome> {
  const { invocation, dependencies, processes, terminal } = ctx;
  if (invocation.argv.length !== 1) {
    return { exitCode: 2, stderr: "dot: usage: dot reconcile\n", stdout: "" };
  }
  try {
    const stdout = await reconcile({
      checkoutRoot: dependencies.checkoutRoot,
      env: invocation.env,
      processes,
      terminal,
    });
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

async function handleSync(ctx: CommandContext): Promise<CommandOutcome> {
  const { invocation, dependencies, processes, terminal } = ctx;
  try {
    const stdout = await sync({
      checkoutRoot: dependencies.checkoutRoot,
      env: invocation.env,
      processes,
      terminal,
    });
    return { exitCode: 0, stderr: "", stdout };
  } catch (error) {
    return failureOutcome(error);
  }
}

const SINGLE_WORD_HANDLERS: Readonly<Record<string, (ctx: CommandContext) => Promise<CommandOutcome>>> = {
  doctor: handleDoctor,
  drift: handleDrift,
  init: handleInit,
  outdated: handleOutdated,
  pi: handlePi,
  reconcile: handleReconcile,
};

export function createApplication(dependencies: ApplicationDependencies): DotApplication {
  const processes = dependencies.processes ?? bunProcessRunner;
  const terminal = dependencies.terminal ?? systemTerminal;
  return {
    async execute(invocation) {
      const [command] = invocation.argv;
      if (invocation.argv.length === 1 && (command === "help" || command === "--help")) {
        return { exitCode: 0, stderr: "", stdout: renderHelp() };
      }
      if (invocation.argv.length === 1 && command === "--version") {
        return { exitCode: 0, stderr: "", stdout: `dot version ${packageMetadata.version}\n` };
      }

      const ctx: CommandContext = { dependencies, invocation, processes, terminal };
      if (invocation.argv.length === 0) return handleSync(ctx);
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
