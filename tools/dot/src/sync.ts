import { warnWithoutAdminPrivileges } from "./admin";
import { apply } from "./apply";
import { readDeployRecord, writeDeployRecord } from "./deploy-record";
import { collectOutdated, describeOutdated, outdatedCount, readOutdated, writeOutdated } from "./outdated";
import { declaresCasks } from "./packages";
import type { ProcessRunner } from "./process";
import { reconcile } from "./reconcile";
import type { Terminal } from "./terminal";
import { runUpgrades } from "./upgrade";

export class SyncFailure extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

const OFFER_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

interface SyncOptions {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: Date;
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
}

async function confirm(terminal: Terminal, message: string): Promise<boolean> {
  const answer = (await terminal.prompt(message)).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

/**
 * Shows what the background check found, every run, because it is free. Asks about upgrading
 * at most once a week, because an upgrade takes minutes and a cask can need admin rights.
 */
async function outdatedStep(options: SyncOptions, home: string): Promise<string> {
  const now = options.now ?? new Date();
  const report = await readOutdated(options.env, home);
  const summary = describeOutdated(report, now);
  if (!(report && outdatedCount(report) > 0 && options.terminal.interactive)) return summary;

  const record = await readDeployRecord(options.env, home);
  const offered = record.upgradeOfferedAt ? Date.parse(record.upgradeOfferedAt) : 0;
  if (now.getTime() - offered < OFFER_EVERY_MS) return `${summary}Run 'dot upgrade' to install them.\n`;

  const accepted = await confirm(options.terminal, `${summary}Upgrade these now? [Y/n]: `);
  record.upgradeOfferedAt = now.toISOString();
  await writeDeployRecord(options.env, home, record);
  if (!accepted) return "Not upgrading now. Asked again in a week; 'dot upgrade' any time.\n";

  const upgraded = await runUpgrades({ ...options, acceptAll: true }, "");
  const fresh = await collectOutdated({
    checkoutRoot: options.checkoutRoot,
    env: options.env,
    home,
    previous: report,
    processes: options.processes,
  });
  await writeOutdated(options.env, home, fresh);
  return upgraded;
}

/**
 * What bare `dot` does once the launcher has fast-forwarded the checkout: make the machine
 * match it, report and offer updates, then offer to absorb anything the machine has that the
 * checkout lacks. The interactive agent comes last so nothing long runs after it.
 */
export async function sync(options: SyncOptions): Promise<string> {
  const home = options.env.HOME;
  if (!home) throw new Error("HOME is required");
  // Warn before any work so there is still time to elevate and re-run.
  if (await declaresCasks({ checkoutRoot: options.checkoutRoot })) {
    await warnWithoutAdminPrivileges({
      checkoutRoot: options.checkoutRoot,
      env: options.env,
      processes: options.processes,
      terminal: options.terminal,
    });
  }

  let progress = await apply({ ...options, acceptTracked: false });
  let stage = "update check";
  try {
    progress += await outdatedStep(options, home);
    stage = "reconcile";
    return progress + (await reconcile(options));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // biome-ignore lint/style/useErrorCause: cause is forwarded via SyncFailure's 3rd positional arg, which this rule only checks for in 2nd position
    throw new SyncFailure(message, `${progress}FAILED ${stage}: ${message}\n`, { cause: error });
  }
}
