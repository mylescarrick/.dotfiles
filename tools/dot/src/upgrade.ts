import { apply } from "./apply";
import type { ProcessRunner } from "./process";
import type { Terminal } from "./terminal";

export class UpgradeFailure extends Error {
  constructor(
    message: string,
    readonly stdout: string,
  ) {
    super(message);
  }
}

export async function upgrade(options: {
  readonly acceptAll: boolean;
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
}): Promise<string> {
  if (!options.acceptAll && !options.terminal.interactive) {
    throw new Error("dot upgrade requires an interactive terminal or --yes");
  }

  let progress = await apply({
    acceptTracked: options.acceptAll,
    checkoutRoot: options.checkoutRoot,
    env: options.env,
    processes: options.processes,
    terminal: options.terminal,
  });

  let upgradeHomebrew = options.acceptAll;
  while (!options.acceptAll) {
    const answer = (
      await options.terminal.prompt("Upgrade Homebrew packages? [Y/n]: ")
    )
      .trim()
      .toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") {
      upgradeHomebrew = true;
      break;
    }
    if (answer === "n" || answer === "no") break;
    options.terminal.write("Please answer y or n.\n");
  }

  if (upgradeHomebrew) {
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
      const result = await options.processes.run({
        argv: command.argv,
        cwd: options.checkoutRoot,
        env: options.env,
        output: "inherit",
      });
      if (result.exitCode !== 0) {
        throw new UpgradeFailure(
          command.failure,
          `${progress}FAILED ${command.stage}: ${command.failure}\n`,
        );
      }
    }
    progress += "Homebrew packages upgraded\n";
  } else {
    progress += "Homebrew upgrade skipped\n";
  }

  const pi = await options.processes.run({
    argv: ["pi", "update", "--all"],
    cwd: options.checkoutRoot,
    env: options.env,
    output: "inherit",
  });
  if (pi.exitCode !== 0) {
    const message = "Pi and configured package update failed";
    throw new UpgradeFailure(message, `${progress}FAILED Pi update: ${message}\n`);
  }

  return `${progress}Pi and configured packages updated\n`;
}
