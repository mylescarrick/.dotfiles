import { warnWithoutAdminPrivileges } from "./admin";
import { apply } from "./apply";
import { declaresCasks, repairStaleCasks } from "./packages";
import type { ProcessRunner } from "./process";
import type { Terminal } from "./terminal";

export class UpgradeFailure extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

interface UpgradeOptions {
  readonly acceptAll: boolean;
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
}

/** Runs one upgrade stage, converting any failure (a nonzero exit, or a thrown error from a JS-level stage) into an UpgradeFailure that carries the progress logged so far. */
async function runStage(
  progress: string,
  stage: string,
  work: () => Promise<{ exitCode: number; message: string } | string>
): Promise<string> {
  let outcome: { exitCode: number; message: string } | string;
  try {
    outcome = await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // biome-ignore lint/style/useErrorCause: cause is forwarded via UpgradeFailure's 3rd positional arg, which this rule only checks for in 2nd position
    throw new UpgradeFailure(message, `${progress}FAILED ${stage}: ${message}\n`, { cause: error });
  }
  if (typeof outcome === "string") return outcome;
  if (outcome.exitCode !== 0) {
    throw new UpgradeFailure(outcome.message, `${progress}FAILED ${stage}: ${outcome.message}\n`);
  }
  return "";
}

async function promptForHomebrewUpgrade(options: UpgradeOptions): Promise<boolean> {
  if (options.acceptAll) return true;
  for (;;) {
    const answer = (await options.terminal.prompt("Upgrade Homebrew packages? [Y/n]: ")).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    options.terminal.write("Please answer y or n.\n");
  }
}

async function upgradeHomebrew(options: UpgradeOptions, progress: string): Promise<string> {
  if (!(await promptForHomebrewUpgrade(options))) return "Homebrew upgrade skipped\n";

  for (const command of [
    {
      argv: ["brew", "update"] as const,
      failure: "Homebrew metadata update failed",
      stage: "Homebrew metadata update",
    },
    {
      argv: ["brew", "upgrade"] as const,
      failure: "Homebrew package upgrade failed",
      stage: "Homebrew package upgrade",
    },
  ]) {
    await runStage(progress, command.stage, async () => {
      const result = await options.processes.run({
        argv: command.argv,
        cwd: options.checkoutRoot,
        env: options.env,
        output: "inherit",
      });
      return { exitCode: result.exitCode, message: command.failure };
    });
  }
  return "Homebrew packages upgraded\n";
}

export async function upgrade(options: UpgradeOptions): Promise<string> {
  if (!(options.acceptAll || options.terminal.interactive)) {
    throw new Error("dot upgrade requires an interactive terminal or --yes");
  }

  // Warn before any work so there is still time to elevate and re-run.
  if (await declaresCasks({ checkoutRoot: options.checkoutRoot })) {
    await warnWithoutAdminPrivileges({
      checkoutRoot: options.checkoutRoot,
      env: options.env,
      processes: options.processes,
      terminal: options.terminal,
    });
  }

  let progress = await apply({
    acceptTracked: options.acceptAll,
    checkoutRoot: options.checkoutRoot,
    env: options.env,
    processes: options.processes,
    terminal: options.terminal,
  });

  progress += await upgradeHomebrew(options, progress);

  progress += await runStage(progress, "cask repair", () =>
    repairStaleCasks({ checkoutRoot: options.checkoutRoot, env: options.env, processes: options.processes })
  );

  progress += await runStage(progress, "Bun runtime upgrade", async () => {
    const result = await options.processes.run({
      argv: ["bun", "upgrade"],
      cwd: options.checkoutRoot,
      env: options.env,
      output: "inherit",
    });
    return { exitCode: result.exitCode, message: "Bun runtime upgrade failed" };
  });
  progress += "Bun runtime upgraded\n";

  progress += await runStage(progress, "Pi update", async () => {
    const result = await options.processes.run({
      argv: ["pi", "update", "--all"],
      cwd: options.checkoutRoot,
      env: options.env,
      output: "inherit",
    });
    return { exitCode: result.exitCode, message: "Pi and configured package update failed" };
  });

  return `${progress}Pi and configured packages updated\n`;
}
