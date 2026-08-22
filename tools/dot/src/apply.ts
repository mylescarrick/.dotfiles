import { reconcileGlobalBunPackages } from "./bun-global";
import { guardCanonicalCheckout } from "./checkout";
import { applyClaudeSettings, planClaudeSettings } from "./claude";
import { reconcilePackages } from "./packages";
import { applyPiSettings, planPiClaudeBridgeSettings, planPiSettings } from "./pi";
import { reconcilePiDependencies } from "./pi-dependencies";
import { reconcilePiPackages } from "./pi-packages";
import type { ProcessRunner } from "./process";
import { validateSkillLinks } from "./skills";
import { applyStowPlan, planStow } from "./stow";
import type { Terminal } from "./terminal";

export class ApplyFailure extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    options?: ErrorOptions
  ) {
    super(message, options);
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
    await Promise.all([
      planPiSettings({ checkoutRoot: options.checkoutRoot, home }),
      planPiClaudeBridgeSettings({ checkoutRoot: options.checkoutRoot, home }),
      planClaudeSettings({ checkoutRoot: options.checkoutRoot, home }),
    ]);

    stage = "skill-link validation";
    progress += await validateSkillLinks(options);

    stage = "Stow conflict preflight";
    const stowPlan = await planStow({ ...options, home });

    stage = "package reconciliation";
    progress += await reconcilePackages(options);

    stage = "global Bun package reconciliation";
    progress += await reconcileGlobalBunPackages(options);

    stage = "dotfile publication";
    progress += await applyStowPlan(stowPlan);

    stage = "Pi settings synchronization";
    const piSettings = await planPiSettings({
      checkoutRoot: options.checkoutRoot,
      home,
    });
    const piClaudeBridgeSettings = await planPiClaudeBridgeSettings({
      checkoutRoot: options.checkoutRoot,
      home,
    });
    const claudeSettings = await planClaudeSettings({
      checkoutRoot: options.checkoutRoot,
      home,
    });

    const [changed, bridgeChanged, claudeChanged] = await Promise.all([
      applyPiSettings(piSettings),
      applyPiSettings(piClaudeBridgeSettings),
      applyClaudeSettings(claudeSettings),
    ]);
    progress += `${changed ? "Pi settings synced" : "Pi settings already current"}\n`;
    progress += `${bridgeChanged ? "Pi Claude Bridge settings synced" : "Pi Claude Bridge settings already current"}\n`;
    if (claudeSettings.tracked) {
      progress += `${claudeChanged ? "Claude settings synced" : "Claude settings already current"}\n`;
    }

    stage = "Pi dependency reconciliation";
    progress += await reconcilePiDependencies({ ...options, home });

    stage = "Pi package reconciliation";
    progress += await reconcilePiPackages({
      checkoutRoot: options.checkoutRoot,
      env: options.env,
      home,
      processes: options.processes,
    });
    return progress;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // biome-ignore lint/style/useErrorCause: cause is forwarded via ApplyFailure's 3rd positional arg, which this rule only checks for in 2nd position
    throw new ApplyFailure(message, `${progress}FAILED ${stage}: ${message}\n`, { cause: error });
  }
}
