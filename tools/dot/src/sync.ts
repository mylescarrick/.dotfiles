import { warnWithoutAdminPrivileges } from "./admin";
import { apply } from "./apply";
import { declaresCasks } from "./packages";
import type { ProcessRunner } from "./process";
import { reconcile } from "./reconcile";
import type { Terminal } from "./terminal";

export class SyncFailure extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

/**
 * What bare `dot` does once the launcher has fast-forwarded the checkout: make the machine
 * match it, then offer to absorb anything the machine has that the checkout lacks.
 */
export async function sync(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
}): Promise<string> {
  // Warn before any work so there is still time to elevate and re-run.
  if (await declaresCasks({ checkoutRoot: options.checkoutRoot })) {
    await warnWithoutAdminPrivileges({
      checkoutRoot: options.checkoutRoot,
      env: options.env,
      processes: options.processes,
      terminal: options.terminal,
    });
  }

  const progress = await apply({ ...options, acceptTracked: false });
  try {
    return progress + (await reconcile(options));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // biome-ignore lint/style/useErrorCause: cause is forwarded via SyncFailure's 3rd positional arg, which this rule only checks for in 2nd position
    throw new SyncFailure(message, `${progress}FAILED reconcile: ${message}\n`, { cause: error });
  }
}
