import { guardCanonicalCheckout } from "./checkout";
import { reconcilePackages } from "./packages";
import { reconcilePiDependencies } from "./pi-dependencies";
import { applyPiSettings, planPiSettings } from "./pi";
import type { ProcessRunner } from "./process";
import { validateSkillLinks } from "./skills";
import { applyStowPlan, planStow } from "./stow";
import type { Terminal } from "./terminal";

export class ApplyFailure extends Error {
  constructor(
    message: string,
    readonly stdout: string,
  ) {
    super(message);
  }
}

export async function apply(options: {
  readonly acceptTracked: boolean;
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
}): Promise<string> {
  let progress = "";
  let stage = "checkout validation";
  try {
    // Revalidate here even when init already guarded before its bootstrap stages.
    await guardCanonicalCheckout(options);
    const home = options.env.HOME;
    if (!home) throw new Error("HOME is required");

    stage = "Pi settings preflight";
    await planPiSettings({ checkoutRoot: options.checkoutRoot, home });

    stage = "skill-link validation";
    progress += await validateSkillLinks(options);

    stage = "Stow conflict preflight";
    const stowPlan = await planStow({ ...options, home });

    stage = "package reconciliation";
    progress += await reconcilePackages(options);

    stage = "dotfile publication";
    progress += await applyStowPlan(stowPlan);

    stage = "Pi settings synchronization";
    const piSettings = await planPiSettings({
      checkoutRoot: options.checkoutRoot,
      home,
    });
    const changed = await applyPiSettings(piSettings);
    progress += `${changed ? "Pi settings synced" : "Pi settings already current"}\n`;

    stage = "Pi dependency reconciliation";
    progress += await reconcilePiDependencies({ ...options, home });
    return progress;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApplyFailure(message, `${progress}FAILED ${stage}: ${message}\n`);
  }
}
