import { guardCanonicalCheckout } from "./checkout";
import { reconcilePackages } from "./packages";
import { reconcilePiDependencies } from "./pi-dependencies";
import { applyPiSettings, planPiSettings } from "./pi";
import type { ProcessRunner } from "./process";
import { validateSkillLinks } from "./skills";
import { applyStow } from "./stow";
import type { Terminal } from "./terminal";

export async function apply(options: {
  readonly acceptTracked: boolean;
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
}): Promise<string> {
  await guardCanonicalCheckout(options);
  const home = options.env.HOME;
  if (!home) throw new Error("HOME is required");
  await planPiSettings({ checkoutRoot: options.checkoutRoot, home });
  const skillSummary = await validateSkillLinks(options);
  const packageSummary = await reconcilePackages(options);
  const stowSummary = await applyStow({ ...options, home });
  const piSettings = await planPiSettings({
    checkoutRoot: options.checkoutRoot,
    home,
  });
  const changed = await applyPiSettings(piSettings);
  const dependencySummary = await reconcilePiDependencies({ ...options, home });
  return `${skillSummary}${packageSummary}${stowSummary}${changed ? "Pi settings synced" : "Pi settings already current"}\n${dependencySummary}`;
}
